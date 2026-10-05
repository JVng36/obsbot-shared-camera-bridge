# Setup and reuse guide

For the manual Linux adaptation, use [LINUX.md](LINUX.md), including its native
hardware and client identity deployment gates.


This guide installs the community extension for Hermes Agent: a privacy bridge on a 64-bit Windows host physically connected to an OBSBOT Tiny 2, plus its client plugin on one or more Hermes hosts. The camera host performs capture and local vision. Hermes agents receive only authenticated text responses over loopback or Tailscale.

Read [THREAT-MODEL.md](THREAT-MODEL.md) before enabling hardware access.

## 1. Prerequisites

On the Windows camera host:

- OBSBOT Tiny 2, connected and working in OBSBOT Center;
- 64-bit Windows 10 or 11;
- Git;
- Node.js 22 or newer;
- CMake 3.20 or newer;
- Visual Studio 2022 Build Tools with **Desktop development with C++**;
- Ollama and a local vision model, tested with `qwen3-vl:8b`;
- Tailscale when an agent runs on another machine or inside a route that reaches the host over the tailnet.

On every Hermes host:

- a current Hermes Agent installation with native plugin support;
- private reachability to the Windows bridge over loopback or Tailscale;
- a separate bearer token file for that principal.

Do not expose the bridge through a public IP, a router port-forward, a public tunnel, or `0.0.0.0`.

## 2. Clone the repository

Choose a private local directory and clone this repository. The remaining commands assume PowerShell is open at the repository root.

```powershell
git clone <repository-url>
Set-Location .\obsbot-shared-camera-bridge
```

Do not clone into a web-served directory or a shared synchronization folder. Runtime configuration contains credentials.

## 3. Reconstruct the pinned OBSBOT adapter

The adapter is not vendored into this repository. `vendor.lock.json` pins the reviewed upstream commit, and `patches/obsbot-mcp-hardening.patch` pins the original dependency-lock and Windows UTF-8 build changes used by this bridge. Both installers additionally apply `patches/obsbot-mcp-dependencies.patch`, which updates only the locked production dependencies fast-uri (3.1.8), hono (4.13.13), and ip-address (10.7.3). The Windows installer does not apply Linux native changes. Production audits remain mandatory; development-only advisories are tracked separately.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-ObsbotAdapter.ps1
```

The installer:

1. clones the pinned upstream repository into `vendor\obsbot-mcp`;
2. verifies the full commit ID;
3. applies the reviewed patch;
4. installs the patched lockfile with `npm ci`;
5. requires a zero-finding production dependency audit;
6. builds the TypeScript code;
7. runs the full upstream test suite;
8. builds the native helper from source and stages the exact binary the runtime loads;
9. prints the resulting helper SHA-256.

The installer refuses to overwrite an existing destination. If a prior attempt exists, inspect it and move it aside deliberately before retrying.

## 4. Install the local vision model

```powershell
ollama pull qwen3-vl:8b
ollama list
```

The bridge accepts only a loopback vision endpoint. It will not send raw frames to a LAN, tailnet, or cloud vision URL.

## 5. Create private runtime configuration

Copy the non-runnable example:

```powershell
Copy-Item .\config.example.json .\secrets.json
```

Generate one independent 32-byte Base64URL token per principal. Run this block once for each principal and paste each output directly into `secrets.json`:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
[Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
```

A principal ID must be lowercase, begin with a letter, contain only letters, digits, `_`, or `-`, and be at most 32 characters. `system` is reserved. Configure between one and eight principals. Set `operatorPrincipal` explicitly to the human operator's principal ID; the local Windows prompt editor uses that principal's token. The `tokens` and `sources` objects must contain exactly the same principal IDs.

Example shape:

```json
{
  "bindHost": "100.64.0.10",
  "port": 8766,
  "minutes": 30,
  "operatorPrincipal": "operator",
  "tokens": {
    "operator": "REPLACE_WITH_43_OR_MORE_BASE64URL_CHARACTERS",
    "agent_a": "REPLACE_WITH_A_DIFFERENT_43_OR_MORE_BASE64URL_TOKEN"
  },
  "sources": {
    "operator": ["100.64.0.10"],
    "agent_a": ["100.64.0.11"]
  },
  "vision": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3-vl:8b"
  }
}
```

The placeholder strings are deliberately rejected at runtime. Replace every one.

- `bindHost` must be `127.0.0.1`, `::1`, or the camera host's own Tailscale IPv4 address.
- Each `sources` entry is the IP address the bridge actually observes for that principal's client connection.
- On a single-machine setup, use loopback for both `bindHost` and the principal source.
- Containers and NAT can make the observed source differ from the container's internal address. Establish the route first and bind the credential to the source visible at the Windows host.

Find a machine's Tailscale IPv4 address with:

```powershell
tailscale ip -4
```

Keep `secrets.json` readable only by the Windows account that launches the bridge. It and rotated copies are ignored by Git, but Git ignore rules are only a backstop, not secret storage.

## 6. Restrict the Windows firewall

When remote tailnet clients need the bridge, allow only the selected local address, TCP port, and client Tailscale addresses. Run an equivalent rule from an elevated operator shell after replacing the placeholders:

```powershell
New-NetFirewallRule `
  -DisplayName 'Shared Camera Bridge' `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalAddress '<camera-host-tailscale-ip>' `
  -LocalPort 8766 `
  -RemoteAddress '<authorized-client-ip-1>','<authorized-client-ip-2>'
```

Do not create a broad public or LAN rule. Loopback-only deployments need no inbound network rule.

## 7. Install the Hermes plugin

The repository contains a native Hermes plugin under `clients\hermes-plugin`. Hermes' official plugin documentation supports user plugins under `$HERMES_HOME/plugins/` and requires third-party plugins to be enabled explicitly.

Find the active profile's configuration and environment paths:

```text
hermes config path
hermes config env-path
```

Copy `clients/hermes-plugin` to an installed plugin directory named `shared-camera` under that profile's `plugins` directory. Examples:

```powershell
Copy-Item -Recurse .\clients\hermes-plugin "$env:USERPROFILE\.hermes\plugins\shared-camera"
```

```bash
cp -R clients/hermes-plugin "${HERMES_HOME:-$HOME/.hermes}/plugins/shared-camera"
```

If the destination already exists, back it up and compare it instead of overwriting blindly.

Create a token file containing only that principal's token. On POSIX systems, restrict its mode:

```bash
install -d -m 700 "$HOME/.config/shared-camera"
printf '%s' '<principal-token>' > "$HOME/.config/shared-camera/token"
chmod 600 "$HOME/.config/shared-camera/token"
```

Set these variables in the environment used by the Hermes process, commonly the active profile's `.env` returned by `hermes config env-path`:

```dotenv
SHARED_CAMERA_URL=http://100.64.0.10:8766
SHARED_CAMERA_AGENT=agent_a
SHARED_CAMERA_TOKEN_FILE=/absolute/path/to/the/principal.token
```

`SHARED_CAMERA_URL`, `SHARED_CAMERA_AGENT`, and `SHARED_CAMERA_TOKEN_FILE` are mandatory profile-scoped pointers. The plugin intentionally ships no camera host, identity, or shared-home token default. A missing scoped pointer fails closed at dispatch.

Validate and enable the plugin:

```text
hermes plugins doctor <path-to-installed-shared-camera-plugin> --ci
hermes plugins enable shared-camera
```

Restart the affected Hermes CLI, Desktop session, or gateway so plugin and environment changes take effect. Confirm that Plugin Doctor reports ten tools and zero hooks.

## 8. Start a finite camera session

Before each activation:

1. confirm the operator intends to activate the camera;
2. close OBSBOT Center completely, including its tray process;
3. confirm no conferencing, browser, OBS, or preview application owns the camera;
4. run `Start Shared Camera.cmd`;
5. choose a duration from 1 through 10,080 minutes (the default is 30);
6. keep the visible console open as the software activation indicator.

The agent plugin cannot start, arm, renew, or reactivate the bridge. It can only inspect an already active session, perform bounded one-frame operations, control PTZ within the forward zone, edit the session-scoped VLM prompt, or Stop.

## 9. Perform supervised physical acceptance

Software tests do not prove physical behavior. On each new camera host, OBSBOT model, adapter update, or material hardware change, supervise at least:

- one snapshot whose text description matches the directly visible scene;
- confirmation that no image path, media payload, or base64 appears in the agent result;
- bounded positive and negative yaw/pitch movement;
- contention between two principals for the short PTZ lease, when using multiple agents;
- Stop while a look is blocked or in progress;
- hard expiry;
- camera LED/handle release and face-down parking;
- console and listener closure;
- unplug or switched-USB fallback when parking cannot be confirmed.

Call the deployment physically accepted only after these checks pass. An automated-tested deployment is not the same state.

## 10. Stop and rollback

Any authorized agent may Stop, and Ctrl+C in the visible console also ends the session. A normal Stop invalidates the session before cleanup, aborts local inference, rejects late results, interrupts an active capture helper, attempts face-down parking, closes the listener, and releases the device.

If Stop returns `parked:false`, cleanup fails, or the hardware state is uncertain, unplug the camera or use a physical USB data switch.

To disable agent access:

```text
hermes plugins disable shared-camera
```

Restart the relevant Hermes process and verify the ten tools are absent. Do not delete unrelated Hermes state, memories, sessions, or other application data during rollback.

## 11. Updating the pinned adapter

Do not change `vendor.lock.json` to a new tag or branch casually. For an update:

1. select a full immutable upstream commit;
2. review the adapter's capture, recording, audio, debug, process-spawn, IPC, and raw-command surfaces;
3. refresh the hardening patch without broadening the allowlist;
4. run the upstream build, full test suite, and production audit;
5. run all bridge and Hermes plugin tests;
6. repeat independent adversarial review;
7. perform supervised physical acceptance again.
