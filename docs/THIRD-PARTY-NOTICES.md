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
- The Linux dependency patch pins fast-uri 3.1.8, hono 4.13.13 and ip-address
  10.7.3. Audit the reconstructed tree with `npm audit --omit=dev`; historical
  lock metadata is not a current vulnerability assessment. Report development
  dependency advisories separately. Production-only installation can use
  `npm ci --omit=dev --ignore-scripts` after building in a separate trusted tree.
- Run the complete upstream test suite after `npm run build`.
- The Windows native helper is compiled from the pinned C++ source on the camera host using Visual Studio. The published prebuilt helper is not used.
- A local CMake-only hardening patch adds MSVC `/utf-8` so the reviewed UTF-8 source is not interpreted through the host's legacy code page. Runtime source logic is unchanged.
- Linux helper capture/shutdown repairs are in `patches/obsbot-mcp-linux.patch`;
  dependency-only updates are in `patches/obsbot-mcp-linux-dependencies.patch`.
  Apply after the original hardening patch, preserving the pin and MIT license.
  Validate exact-pin reconstruction with upstream tests, compiled synthetic C
  fixtures, and ASAN+UBSAN with leak detection. These offline checks do not
  replace independent review or supervised physical acceptance.
