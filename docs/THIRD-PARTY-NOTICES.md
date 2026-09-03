# Third-Party Notices

## obsbot-mcp

- Project: `lxman/obsbot-mcp`
- Repository: https://github.com/lxman/obsbot-mcp
- Version: 0.6.3
- Pinned commit: `81200e519da2ef8c1f5d7a11513eee87b4797833`
- License: MIT
- Copyright: 2026 Michael Jordan

The full upstream MIT license is included in this wrapper bundle at
`docs/licenses/obsbot-mcp-MIT.txt` and in the deployed vendor tree at
`vendor/obsbot-mcp/LICENSE`.

Deployment hardening:

- Only the Tiny 2 UVC device, status, wake/sleep, in-memory snapshot, bounded gimbal, and recenter handlers are imported by the bridge.
- Recording, preview, raw/debug controls, presets, and arbitrary vendor operations are not exposed.
- The npm lockfile was refreshed within compatible ranges using `npm audit fix --package-lock-only --omit=dev`.
- Production dependency audit after hardening: zero known vulnerabilities.
- Upstream test suite after `npm run build`: 586/586 passed.
- The Windows native helper is compiled from the pinned C++ source on the camera host using Visual Studio. The published prebuilt helper is not used.
- A local CMake-only hardening patch adds MSVC `/utf-8` so the reviewed UTF-8 source is not interpreted through the host's legacy code page. Runtime source logic is unchanged.
