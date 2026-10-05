# Pinned helper lifecycle fixture

`helper-process.ts` is an exact, unmodified public source copy from
[lxman/obsbot-mcp](https://github.com/lxman/obsbot-mcp/blob/81200e519da2ef8c1f5d7a11513eee87b4797833/src/transport/helper-process.ts),
commit `81200e519da2ef8c1f5d7a11513eee87b4797833`, path
`src/transport/helper-process.ts`. Copyright 2026 Michael Jordan, MIT licensed.
The exact original upstream `LICENSE` is included. `provenance.json` records the
pin and SHA256 of both exact copies; the lifecycle test verifies those hashes.

This fixture makes root tests independent of the ignored vendor installation.
The test copies this source into an isolated scratch Git root, requires the
helper-process portion of the Linux patch to pass `git apply --check`, applies it,
verifies that the patched bytes changed, and exercises the
patched close method against an owned fake child. It never imports this fixture
as a module or runs a native helper. Full upstream TypeScript compilation and
manager integration remain separate reconstruction gates.
