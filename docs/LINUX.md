# Linux support

This is a visible-terminal, nonroot, finite-session adaptation. Installation and
configuration are operator tasks, separate from publication. The scripts do not
install services, enable autostart, renew sessions, install OS packages, or perform
hardware acceptance. Windows launchers remain available.

## Prerequisites and reconstruction

Use Linux, Bash, util-linux `flock`, GNU `stat`, Node >=22, Git, npm, CMake >=3.20,
a C11 compiler, Linux V4L2 headers, and libjpeg development headers/library.
Node's architecture must match the native architecture (x64 or arm64). Launcher
tests also require Python 3 with PTY support. Provision local Ollama and the
selected model separately; no script downloads a model.

From the repository root, reconstruct into an **absent** destination:

```sh
./scripts/install-obsbot-adapter.sh --destination "$PWD/vendor/obsbot-mcp"
```

The script reads `vendor.lock.json`, verifies pinned upstream commit
`81200e519da2ef8c1f5d7a11513eee87b4797833`, and applies these patches in order:

1. `patches/obsbot-mcp-hardening.patch`
2. `patches/obsbot-mcp-linux.patch`
3. `patches/obsbot-mcp-dependencies.patch` (shared with Windows)

It runs `npm ci`, the upstream build and tests, and the Linux CMake build. It
copies the source-built helper into the vendor platform directory and prints its
SHA256; it never runs that helper. Existing destinations, including failed partial
builds, are refused and are never deleted automatically. Keep the upstream MIT
license. Network and compiler availability are reconstruction prerequisites.

## Private configuration

Use `config.linux.example.json` as a template. Its placeholder credentials are
intentionally invalid. The example addresses are synthetic CGNAT examples, not
deployment addresses. Provision independent random Base64URL credentials and
exact principal/source bindings, including the operator principal. Never commit
the resulting configuration, token files, observations, or host inventories.

Keep configuration separate from the source tree. The config must be an
operator-owned mode-0600 regular file with one hard link, at most 64 KiB, in an
operator-owned mode-0700 directory. Ancestors must be real directories owned by
the operator or root and not writable by group/others. Root-owned sticky `/tmp`
is the only writable-ancestor exception. Symlinks are refused. Keep application
and vendor sources protected from untrusted edits.

The launcher pins directory descriptors with `O_DIRECTORY | O_NOFOLLOW`, traverses
through Linux `/proc/self/fd`, compares identities, bounds the read, and closes
descriptors on failure. This does not sandbox another process with the same UID.

The Linux example explicitly selects these native Ollama `vision` fields:

```json
{
  "baseUrl": "http://127.0.0.1:11434",
  "model": "qwen3.5:9b",
  "num_ctx": 4096,
  "num_predict": 300,
  "keep_alive": 0
}
```

These are not agent auxiliary-vision settings. Only an HTTP loopback origin is
accepted, without credentials, URL suffixes, or redirects. Requests use native
`/api/chat`, `stream:false`, `think:false`, and `temperature:0.2`. The dedicated
Node HTTP Agent bypasses ambient proxy/fetch/global-Agent state. Tests use owned
synthetic endpoints, not the default inference port.

Optional `num_ctx` is an integer 1..32768; `num_predict` is 1..1000 (default 300).
`keep_alive` accepts integer seconds 0..120 or positive `s`/`m` durations of at
most 120 seconds (default `"2m"`). The constructor model default remains
`qwen3.8:27b`; the Linux template explicitly overrides it. A zero residency
request is not proof of memory zeroization. Model availability, context fit, and
quality must be qualified separately. Prompt limits are character limits, not
token budgets. Malformed, oversized, empty, and explicitly truncated responses
fail closed; descriptions retain the 2000-character ceiling.

## Manual activation and Stop

In a visible local terminal, from the repository root:

```sh
./scripts/start-shared-camera.sh \
  --config /absolute/path/to/private/config/secrets.json \
  --vendor-root "$PWD/vendor/obsbot-mcp" \
  --node /absolute/path/to/node
```

Substitute your own protected paths. When `--minutes` is omitted, the launcher
asks for the session duration in minutes. Enter a decimal integer from **1 through
10080**, or press Enter for the **30-minute** default. The prompt includes this
example: **1440 minutes = 24 hours (one full day)**. Invalid duration input or EOF
cancels before Node or device startup.

After choosing the duration, type exactly `START` yourself at the separate
confirmation prompt, which displays the chosen duration. Empty input, `yes`, EOF,
and nonterminal launches refuse activation. To supply the duration directly,
append `--minutes 1440` (one day); this skips only the duration prompt, **not START
confirmation**. There is no auto-confirm flag. The hard maximum remains **10080
minutes (seven days)**. A new session requires another manual confirmation.

Before Node starts, the launcher clears Node preload/module/proxy/diagnostic
variables, dynamic-loader overrides, and OpenSSL overrides, and disables ordinary
core dumps. The invoking shell, PATH tools, selected executable, and source must
still be trusted; swap, privileged crash collection, and server logs are outside
this guarantee. PID-preserving `exec` delivers terminal signals to the runtime.

A per-UID lock under `/tmp/obsbot-shared-camera-UID/owner.lock` is held on fd 9
through exec. The directory is mode 0700 and the file mode 0600. Do not remove or
replace the lock while an owner runs. It coordinates only this launcher for one
user, not other users or camera applications. A remaining file is not a held lock.

Stop with **Ctrl+C**, the authenticated Stop tool, or finite expiry. Stop cancels
work and invalidates authorization before cleanup. The 30-look per-agent quota,
bounded PTZ, token/source identity, prompt controls, and text-only results remain.
A successful sleep acknowledgment (`parked:true`) is **not physical telemetry**;
`parkingVerification:"unverified"` makes that distinction explicit. If shutdown
fails or camera state is uncertain, use physical off or disconnect USB/power.

`scripts/shared-camera.desktop.in` is an optional launcher template, not an
installer or autostart entry. Preserve `Terminal=true` and follow desktop-entry
escaping rules when substituting paths. The template omits `--minutes`, so it
shows the duration prompt before START confirmation.

## Native boundary and acceptance

The bridge exposes a six-handler device allowlist, not arbitrary vendor commands,
recording, preview, audio, or exposure controls. The Linux native patch negotiates
MJPEG 1280x720 for `maxDim=1280`, validates driver metadata and JPEG contents,
bounds allocations, attempts STREAMOFF before encoding, and attempts all resource
cleanup. Unsupported formats, oversized frames, and trailing JPEG data fail
closed rather than invoking a fallback. Hardware padding may therefore require
future investigation, not a validation bypass.

Linux helper close waits for exit, escalates TERM to KILL after 500 ms, and reports
failure after 1500 ms. Manager shutdown retains failed-close owners, drains pending
factories, and rejects post-stop creation. Synthetic fixtures cannot establish
recovery from an uninterruptible kernel/driver.

Snapshots use in-memory buffers and pipes. Freeing/unmapping them is not secure
erasure of all copies, kernel buffers, swap, or inference-server memory/logs.
Derived descriptions can persist in agent history and reach its configured cloud
route even though the bridge sends pixels only to local inference.

The client resolves `SHARED_CAMERA_URL`, `SHARED_CAMERA_AGENT`, and
`SHARED_CAMERA_TOKEN_FILE` through `agent.secret_scope.get_secret` on every
dispatch. Missing scope/pointers fail closed; there is no ambient environment or
shared-home token fallback. Qualify the real runtime's profile binding separately.

## Offline verification

```sh
npm test
PYTHONPATH=clients/hermes-plugin python3 -m unittest discover -s clients/hermes-plugin/tests -p 'test_*.py'
bash -n scripts/start-shared-camera.sh scripts/install-obsbot-adapter.sh
# After exact-pin reconstruction; use an output directory outside tracked files:
sh test/native-snapshot.sh vendor/obsbot-mcp "$TMPDIR/native-fixtures"
NATIVE_CFLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer' \
  ASAN_OPTIONS=detect_leaks=1 \
  sh test/native-snapshot.sh vendor/obsbot-mcp "$TMPDIR/native-sanitizers"
```

Run `npm audit --omit=dev` within the reconstructed vendor tree and report its
actual result separately from the development-dependency audit. Linux dependency
updates do not change the upstream pin or remove its license.

Publication and offline tests do not establish physical acceptance. Before any
separately authorized deployment, review the exact commit and qualify supervised
capture, device permissions/exclusivity, PTZ, Stop during work, expiry, unplug/
replug, handle release, and visible privacy posture. Do not run hardware tests
merely to verify a source publication. See [CONTRIBUTING.md](../CONTRIBUTING.md)
for the source-of-truth and pinned-deployment workflow.
