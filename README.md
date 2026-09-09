# Dominion — update channel

This repository is not the game's source code. It holds two files, and the game
reads them to keep itself up to date:

| File | What it is |
|---|---|
| `update/manifest.json` | The current build number, and where to get it. |
| `update/content.dat` | That build, sealed. About half a megabyte. |

Players are sent `Dominion.exe` once. Every time they open the game it reads the
manifest here; if the build number is higher than theirs it fetches
`content.dat`, checks it against the hash in the manifest, and restarts into it.
The hundred megabytes of that EXE is the Godot engine, which does not change when
the game does — so an update is half a megabyte, not a hundred.

**This repository must stay public.** The game reads it with no credentials of
any kind, which is the point: a token shipped inside a game is a token every
player has.

**Never put the game's source in here.** Only the two files above. The source
lives elsewhere and stays private.

Both files are written by `tools/release.ps1` in the game project. Nothing here
is edited by hand.
