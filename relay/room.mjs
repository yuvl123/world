// The relay's brain: rooms, who is in them, and where a message goes next.
//
// Deliberately free of any I/O or platform API. A socket is represented by an
// opaque object with a `send(text)` method, so this same file runs unchanged
// under Node for local testing and on whichever host ends up carrying it. The
// bugs worth catching here are protocol bugs, and they are much easier to catch
// when the protocol logic is not tangled up with a web framework.
//
// What this thing is FOR: the game's players cannot reach each other directly,
// because home routers do not accept incoming connections without being told to.
// They can all reach this. So everybody connects outward to here, and here
// forwards their messages on. That is the whole idea, and it is why nobody has
// to configure anything.
//
// What this thing deliberately is NOT: it does not understand the game. It never
// inspects a payload, never keeps game state, and never decides anything about
// the match. The host is still the authority, exactly as it was over a direct
// connection - this only carries the envelopes. That keeps the lockstep
// simulation, which is the part that is hard to get right, completely untouched.

// No I, O, 0 or 1 - a room code gets read out loud, and those four are where
// every misheard code comes from. Same alphabet the game already used.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export const MAX_PLAYERS = 6;
/** Bumped when the message shapes below change in a way old clients cannot read. */
export const PROTOCOL = "dominion-relay-1";

/** A room dies this long after its last member leaves, or after this long idle. */
export const EMPTY_ROOM_GRACE_MS = 60 * 1000;
export const IDLE_ROOM_MS = 6 * 60 * 60 * 1000;

/** Refuse anything larger, so one client cannot spend everybody's bandwidth. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export function makeCode(exists) {
  // Rejection-sample until the code is free. With 32^6 possibilities and a
  // handful of live rooms this effectively never loops.
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = "";
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
    if (!exists(code)) return code;
  }
  throw new Error("could not find a free room code");
}

export class Room {
  constructor(code) {
    this.code = code;
    /** peer id -> { socket, name } . The host is always peer 1. */
    this.members = new Map();
    this.nextPeer = 1;
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
    this.emptiedAt = null;
    /** Set once the host says the match has begun; new joins are refused after. */
    this.started = false;
  }

  get size() {
    return this.members.size;
  }

  get host() {
    return this.members.get(1);
  }

  add(socket, name) {
    const peer = this.nextPeer++;
    this.members.set(peer, { socket, name });
    this.emptiedAt = null;
    this.touchedAt = Date.now();
    return peer;
  }

  remove(peer) {
    this.members.delete(peer);
    this.touchedAt = Date.now();
    if (this.members.size === 0) this.emptiedAt = Date.now();
  }

  peerOf(socket) {
    for (const [peer, member] of this.members) {
      if (member.socket === socket) return peer;
    }
    return null;
  }

  roster() {
    return [...this.members].map(([peer, member]) => ({ peer, name: member.name }));
  }

  send(peer, message) {
    const member = this.members.get(peer);
    if (!member) return false;
    try {
      member.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Everyone except `exceptPeer`. Used for roster changes and host broadcasts. */
  broadcast(message, exceptPeer = null) {
    for (const peer of this.members.keys()) {
      if (peer !== exceptPeer) this.send(peer, message);
    }
  }

  expired(now = Date.now()) {
    if (this.emptiedAt !== null && now - this.emptiedAt > EMPTY_ROOM_GRACE_MS) return true;
    return now - this.touchedAt > IDLE_ROOM_MS;
  }
}

/**
 * The relay itself. `rooms` is a plain Map, so a single-process host needs
 * nothing else; a host that runs many isolates has to pin one room to one
 * instance, which is what Cloudflare's Durable Objects do for free.
 */
export class Relay {
  /**
   * `fixedCode` makes this relay serve exactly one room, under a code it was
   * given rather than one it invents. That is what lets the same logic run
   * inside a Cloudflare Durable Object, where the platform has already routed
   * every player of one room to one instance and the code is decided before the
   * socket is even accepted. Left null, the relay mints its own codes and holds
   * as many rooms as it likes, which is the single-process case.
   */
  constructor(options = {}) {
    this.fixedCode = options.fixedCode ?? null;
    this.rooms = new Map();
    /** socket -> { code, peer } , so a disconnect can be cleaned up cheaply. */
    this.where = new Map();
  }

  /** Handles one text frame from one socket. Never throws. */
  handle(socket, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
      return this.#reject(socket, "message too large");
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return this.#reject(socket, "not valid JSON");
    }
    if (!message || typeof message !== "object") {
      return this.#reject(socket, "not a message");
    }

    switch (message.t) {
      case "host":
        return this.#host(socket, message);
      case "join":
        return this.#join(socket, message);
      case "to":
        return this.#forward(socket, message);
      case "started":
        return this.#started(socket);
      case "leave":
        return this.close(socket);
      case "ping":
        // Keeps intermediaries from dropping an idle connection during a long
        // lobby wait. Answered rather than forwarded.
        return this.#reply(socket, { t: "pong" });
      default:
        return this.#reject(socket, "unknown message");
    }
  }

  #host(socket, message) {
    if (message.protocol !== PROTOCOL) {
      return this.#reject(socket, "different version");
    }
    if (this.where.has(socket)) return this.#reject(socket, "already in a room");
    const code = this.fixedCode ?? makeCode((candidate) => this.rooms.has(candidate));
    if (this.rooms.has(code)) return this.#reject(socket, "room already hosted");
    const room = new Room(code);
    this.rooms.set(code, room);
    const peer = room.add(socket, cleanName(message.name));
    this.where.set(socket, { code, peer });
    this.#reply(socket, { t: "hosted", code, peer, roster: room.roster() });
  }

  #join(socket, message) {
    if (message.protocol !== PROTOCOL) {
      return this.#reject(socket, "different version");
    }
    if (this.where.has(socket)) return this.#reject(socket, "already in a room");
    const code = String(message.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const room = this.rooms.get(code);
    if (!room) return this.#reject(socket, "no such room");
    if (room.started) return this.#reject(socket, "match already started");
    if (room.size >= MAX_PLAYERS) return this.#reject(socket, "room is full");

    const peer = room.add(socket, cleanName(message.name));
    this.where.set(socket, { code, peer });
    this.#reply(socket, { t: "joined", code, peer, roster: room.roster() });
    // The host is the authority on the roster, so it is told and everybody
    // else finds out from the host - exactly as over a direct connection.
    room.send(1, { t: "peer_joined", peer, name: cleanName(message.name) });
  }

  #forward(socket, message) {
    const at = this.where.get(socket);
    if (!at) return this.#reject(socket, "not in a room");
    const room = this.rooms.get(at.code);
    if (!room) return this.#reject(socket, "room is gone");
    room.touchedAt = Date.now();

    const envelope = { t: "from", peer: at.peer, m: message.m };
    // peer 0 means "everyone but me" - the broadcast an RPC used to be.
    if (message.peer === 0 || message.peer === undefined || message.peer === null) {
      room.broadcast(envelope, at.peer);
    } else {
      room.send(Number(message.peer), envelope);
    }
  }

  #started(socket) {
    const at = this.where.get(socket);
    if (!at || at.peer !== 1) return;  // Only the host closes the doors.
    const room = this.rooms.get(at.code);
    if (room) room.started = true;
  }

  /** A socket went away, for any reason. */
  close(socket) {
    const at = this.where.get(socket);
    this.where.delete(socket);
    if (!at) return;
    const room = this.rooms.get(at.code);
    if (!room) return;
    room.remove(at.peer);

    if (at.peer === 1) {
      // The host left. Without an authority there is no match, so the room
      // ends for everybody rather than leaving them waiting on nothing.
      room.broadcast({ t: "closed", reason: "host left" });
      this.rooms.delete(at.code);
      return;
    }
    room.broadcast({ t: "peer_left", peer: at.peer });
  }

  /** Call periodically. Returns how many rooms were reaped. */
  sweep(now = Date.now()) {
    let reaped = 0;
    for (const [code, room] of [...this.rooms]) {
      if (room.expired(now)) {
        room.broadcast({ t: "closed", reason: "room expired" });
        this.rooms.delete(code);
        reaped++;
      }
    }
    return reaped;
  }

  #reply(socket, message) {
    try {
      socket.send(JSON.stringify(message));
    } catch { /* the socket is already gone; the close handler will tidy up */ }
  }

  #reject(socket, reason) {
    this.#reply(socket, { t: "rejected", reason });
  }
}

function cleanName(value) {
  const text = String(value ?? "").trim().slice(0, 24);
  return text.length > 0 ? text : "שחקן";
}
