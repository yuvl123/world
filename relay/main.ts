// The relay as a single ordinary server. Deno, one process, rooms in memory.
//
//     deno run --allow-net tools/relay/deploy.ts [port]
//
// Correct for anywhere that runs exactly ONE instance of it: a VPS, a container,
// a machine in a cupboard, or a local test. Every player in a room reaches the
// same process, which is the only thing a relay actually requires.
//
// It is NOT correct on a platform that scales to several isolates behind one
// address, which most serverless hosts do under load. Rooms live in this
// process's memory, so two friends served by two isolates would each hold half a
// room and never see one another - intermittently, and only once more than one
// isolate is awake, which is the worst kind of bug to be handed. For a hosted
// deployment use `cloudflare/`, where a Durable Object per room code makes
// "everybody in one room lands on one instance" a guarantee rather than a hope.
//
// All the decisions live in ./room.mjs, the same file the protocol tests cover.

import { Relay, PROTOCOL, MAX_PLAYERS } from "./room.mjs";

const port = Number(Deno.args[0] ?? 8000);
const relay = new Relay();

Deno.serve({ port }, (request) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(
      `Dominion relay is up.\nprotocol ${PROTOCOL}\nrooms ${relay.rooms.size}\nmax ${MAX_PLAYERS} players per room\n`,
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // The path carries the intent for hosts that need to route before accepting
  // (see cloudflare/). One process needs no routing, so it is ignored here and
  // the greeting message decides, exactly as it does locally.
  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.onmessage = (event) => {
    if (typeof event.data === "string") relay.handle(socket, event.data);
  };
  socket.onclose = () => relay.close(socket);
  socket.onerror = () => relay.close(socket);
  return response;
});

setInterval(() => relay.sweep(), 30_000);
console.log(`[relay] listening on :${port}, protocol ${PROTOCOL}`);
