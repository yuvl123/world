# Dominion relay

The little server that lets people play together without configuring anything.

Players do not connect to each other. Every player — the host included — opens
one outbound WebSocket to this, and it passes messages between them. A connection
*out* is one that every home router already allows, which is why nobody has to
forward a port, enable UPnP, or log into anything.

| File | What it is |
|---|---|
| `room.mjs` | Rooms, routing, refusals. All the decisions live here. No I/O. |
| `main.ts` | The web server around it. This is the deploy entrypoint. |

It never inspects a game message and never keeps game state. The host remains the
authority over the match exactly as it was on a direct connection; this only
carries the envelopes.

The logic in `room.mjs` is covered by a test suite in the game repository
(`tools/relay/room.test.mjs`, 40 checks) and by full multi-process match tests
that run a real game through a local copy of this server.

## Deploying

Entrypoint: `relay/main.ts`. Nothing to configure, no secrets, no storage.

**One instance only.** Rooms live in this process's memory, so every player of a
room must reach the same instance. On a platform that scales to several isolates
under load, two friends could each end up holding half a room and never see one
another. If that ever shows up, the game repository has a Cloudflare Durable
Objects version where one object per room code makes that a guarantee — and
because the game updates itself, switching to it is a published update rather
than a redistribution.
