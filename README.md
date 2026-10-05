# OBSBOT Shared Camera Bridge for Hermes Agent

A privacy-first OBSBOT camera extension for [Hermes Agent](https://hermes-agent.nousresearch.com/). It gives authorized Hermes agents explicitly activated, finite, text-only camera perception and bounded PTZ controls.

This community extension is not bundled with or maintained by Hermes Agent. It combines a host-side Windows or Linux privacy bridge with an installable Hermes plugin, so camera ownership and raw-frame handling remain outside the agent runtime.

## Architecture

```text
OBSBOT Tiny 2
  -> reviewed UVC helper built from source on the camera host
  -> one in-memory JPEG snapshot per look
  -> configured vision model through loopback Ollama
  -> text-only authenticated response
  -> authorized Hermes agent tool
```

The host bridge process is the only camera owner. It serializes capture and PTZ across configured agents. It binds only to a loopback or Tailscale address, authenticates each configured principal with a different token, and binds each token to that principal's observed source address.

The operator and authorized agents share one bridge-session-scoped VLM system prompt. Authorized edits are live, revision-checked, and resolved immediately before the next local inference. The bridge itself retains only the current prompt and metadata-only history; a new bridge process starts from the known-good default. Agent tool calls are different: full prompt arguments/results are ordinary Hermes conversation data and may persist in Hermes state/logs or enter a cloud-backed agent route.

## Activation contract

- No service, scheduled task, login item, or automatic restart.
- The operator starts each session through `Start Shared Camera.cmd` on Windows or the visible-terminal Linux launcher in [docs/LINUX.md](docs/LINUX.md).
- Duration is explicit and hard-capped at seven days (`10080` minutes); the default remains 30 minutes.
- The visible console names the active session and its duration.
- The Hermes plugin exposes no start or arm tool.
- Either authorized agent may stop the session immediately. Ctrl+C in the console also stops it.
- Normal stop or expiry aborts local vision, invalidates late results, interrupts an in-flight native snapshot by closing its helper, attempts sleep through a fresh helper, closes the HTTP listener, and releases the device helper. `parked` reports sleep acknowledgment, not physical confirmation; `parkingVerification` remains `unverified`.

## Data contract

- Raw frames exist only in host process memory and the loopback Ollama request.
- No camera image or video file is written by this bridge.
- Recording, preview, arbitrary vendor commands, and debug probes are not exposed.
- Agent look responses contain text from the configured local vision model only.
- Text observations subsequently enter the active agent conversation route. If that route is cloud-backed, that text may leave the camera host. Raw frames do not.
- Bridge request logs contain only an allowlisted route identifier (or `<unknown>`), method, agent identity, status, and timing. They contain no prompts, images, descriptions, tokens, or attacker-controlled paths. Hermes' own tool/session logs have separate retention semantics described below.

## Live shared VLM prompt

- `get`: return the complete active system prompt and revision metadata.
- `replace`: replace the entire prompt using the exact expected revision.
- `append`: append experimental instructions using the exact expected revision.
- `reset`: restore the original known-good prompt.
- `status`: show revision, updater, time, action, size, SHA-256, and bounded metadata history.
- Operator local GUI: `Edit Shared VLM Prompt.cmd`.

The prompt may be neutral, playful, subjective, character-specific, or deliberately permissive. That changes only local VLM interpretation. Camera ownership and privacy mechanics remain enforced outside the prompt.

**Retention warning:** `shared_camera_prompt_get`, `replace`, and `append` necessarily carry prompt bodies as Hermes tool results or arguments. Those bodies are retained like ordinary conversation/tool data and may reach the active cloud model. Use the operator's local GUI when prompt text should remain outside Hermes; the GUI sends it directly to the local bridge, disables proxies/redirects, and does not write prompt text to disk.

## Source layout

- `src/`: cross-platform bridge and privacy policy boundary
- `clients/hermes-plugin/`: bounded Hermes client plugin for an authorized principal
- `test/`: Node policy, integration, launcher, and vendor-bootstrap tests
- `Start-SharedCamera.ps1`: visible finite launcher
- `scripts/Install-ObsbotAdapter.ps1`: pinned adapter reconstruction and verification
- `patches/obsbot-mcp-hardening.patch`: reviewed dependency-lock and Windows build hardening
- `vendor.lock.json`: immutable upstream source and reconstruction metadata
- `docs/SETUP.md`: clean-machine Windows and Hermes installation guide
- `docs/LINUX.md`: Linux prerequisites, manual launcher, native reconstruction, and acceptance gates
- `scripts/install-obsbot-adapter.sh`: pinned Linux reconstruction with ordered native and dependency patches
- `docs/OPERATIONS.md`: routine operation, Stop, troubleshooting, and rollback
- `docs/THREAT-MODEL.md`: guarantees, trust boundaries, and explicit limits

The generated `vendor/obsbot-mcp/` tree is intentionally excluded from Git. Reconstruct it from the pinned commit and reviewed patch instead of publishing a private machine's build artifacts.

## License

The bridge, Hermes plugin, scripts, tests, and documentation are released under the [MIT License](LICENSE). The reconstructed `obsbot-mcp` dependency remains under its upstream MIT license, reproduced in [`docs/licenses/obsbot-mcp-MIT.txt`](docs/licenses/obsbot-mcp-MIT.txt).

Start with `docs/SETUP.md` (Windows) or `docs/LINUX.md` (Linux), then read `docs/OPERATIONS.md` before the first live session. GitHub is the development source of truth; deployment is a separate, explicitly authorized operation pinned to an exact commit. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Verification status

- Run `npm test` and the Python client/plugin suite for offline bridge verification. Linux tests use owned synthetic endpoints, fake helpers, and fixtures; they do not activate a camera or call a real model.
- Reconstruct the pinned adapter and run its build, upstream tests, dependency audit, and native synthetic fixtures separately. Consult the pull request checks for current results rather than treating historical audit metadata as a current guarantee.
- GitHub CI covers the Windows/Linux bridge suites, Plugin Doctor, and adapter reconstruction. A passing synthetic suite is not independent native review or physical acceptance.
- Every host, camera model, adapter update, or material hardware change requires supervised physical acceptance before use. Publishing source does not merge, deploy, restart, or activate anything.
