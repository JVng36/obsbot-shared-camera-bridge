# Shared Camera Operations

For the manual Linux adaptation, use [LINUX.md](LINUX.md), including its native
hardware and client identity deployment gates.


## Installed paths

- Bridge: `<bridge-root>`
- Visible launcher: `<bridge-root>/Start Shared Camera.cmd`
- Agent plugin: configure per Hermes profile, for example `~/.hermes/plugins/shared-camera`
- Agent token: the explicit profile-scoped `$SHARED_CAMERA_TOKEN_FILE`; no shared-home fallback

Each agent must set `SHARED_CAMERA_URL`, `SHARED_CAMERA_AGENT`, and `SHARED_CAMERA_TOKEN_FILE` explicitly in its own profile. Do not ship private host or identity defaults with the plugin.

## Start a session

1. Confirm the operator intends to activate the camera.
2. Close OBSBOT Center completely, including its tray process. The launcher refuses competing ownership.
3. Run `Start Shared Camera.cmd`.
4. Enter a duration from 1 through 10,080 minutes. Default is 30; 10,080 is seven days.
5. Keep the cyan console visible or intentionally minimized. It is the software activation indicator.
6. Ask an authorized agent for one look. Each call captures exactly one frame and returns a local text description.

## During a session

- `Look once`: one snapshot, local Qwen3-VL analysis, text-only response.
- `Move`: yaw is limited to -60 through +60 degrees; pitch to -30 through +45 degrees.
- The first mover receives a 15-second PTZ lease. The other agent must wait rather than yank the gimbal.
- PTZ lease expiry is clamped to the parent camera-session deadline and can never extend camera activation.
- Each agent receives at most 30 successful looks per session, with at least two seconds between starts.

## Edit the shared VLM prompt live

While the bridge session is active, run:

```text
<bridge-root>/Edit Shared VLM Prompt.cmd
```

The editor loads the complete active prompt into memory and shows camera expiry,
revision, updater, action, character count, digest prefix, and bounded revision
metadata. **Replace complete**, **Append**, and **Reset default** all use the
revision currently loaded in the editor. If another authorized principal edited first, the
operation fails with a revision conflict; press **Reload** rather than overwriting.

Agent tools provide equivalent get/status/replace/append/reset operations. Prompt
changes affect the next local VLM inference without a bridge or model restart.
The bridge does not archive prior prompt bodies, and ending the camera session
restores the original prompt for the next launch. However, prompt bodies passed
through agent `get`, `replace`, or `append` tools are ordinary Hermes tool
arguments/results: they can persist in Hermes `state.db` and verbose logs and may
enter the active cloud-backed model route. Use the operator's local editor when prompt text
should stay outside Hermes. The editor pins the destination to loopback/Tailscale,
disables proxies/redirects, caps and schema-validates responses, and does not
write prompt text to disk.

The prompt is a deliberately permissive experiment surface and can replace the
default observation/safety language completely. It cannot activate or extend the
camera session, alter Stop/expiry, create a stream, export pixels, retain frames,
or bypass PTZ limits.

## Stop immediately

Any of these ends the whole session:

- Tell an authorized agent: `stop looking`, `camera off`, `enough`, or `quiet`.
- Press Ctrl+C in the active camera console.
- Wait for hard expiry.

Stop invalidates the session before cleanup, interrupts any blocked snapshot helper, and reports whether a fresh helper confirmed face-down parking. After a normal stop, verify the gimbal parks and the console exits. If `parked:false` or cleanup fails, unplug the USB cable or use the physical USB switch. Physical disconnection is the strongest off state.

## Health checks without taking a frame

```powershell
Get-NetTCPConnection -LocalAddress 100.64.0.10 -LocalPort 8766 -State Listen
```

Replace `100.64.0.10` with the configured bind host. Use an authorized agent's authenticated `shared_camera_status` tool for application health and session state. `/health` is also token- and source-bound; do not place credentials in a command line or URL merely to call it manually.

## Troubleshooting order

1. Is the visible bridge console still active and unexpired?
2. Is OBSBOT Center fully closed?
3. Does Windows still show `OBSBOT Tiny 2 StreamCamera` as healthy?
4. Does `ollama list` include `qwen3-vl:8b`?
5. Can the camera host answer `http://127.0.0.1:11434/api/tags`?
6. Does the bridge console show a content-free HTTP/device error?
7. If the camera is busy, close conferencing, OBS, browser-camera, and other preview apps before retrying.
8. If the helper lost the device after replugging, stop the session and launch a fresh one.
9. If a prompt edit reports a revision conflict, reload prompt state and deliberately reapply the edit against the new revision.

Do not expose the bridge on `0.0.0.0`, the LAN address, or the public Internet. Do not add recording as a workaround.

## Updates and rollback

- The device layer is pinned in `vendor.lock.json`. Review source and rerun its full suite before updating.
- Roll back agent access by disabling the `shared-camera` plugin and restarting the relevant Hermes gateway.
- Roll back the Windows console application by stopping any active session, then deleting or renaming the bridge directory.
- Do not delete unrelated agent memory, sessions, or configuration during camera rollback.
