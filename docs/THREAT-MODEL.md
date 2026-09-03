# Threat Model and Privacy Boundary

## Protected assets

- Raw images of the permitted subject and the room
- Camera and microphone access state
- PTZ control
- Per-agent bearer tokens
- Configured principal identity separation
- Shared-prompt authorship and revision integrity
- Shared-prompt body retention and route visibility
- The operator's ability to withdraw consent immediately

The bridge does not access or expose the Tiny 2 microphone.

## Trust boundaries

1. **Windows host process:** owns the Tiny 2 and raw in-memory frame.
2. **Loopback Ollama:** receives the frame for Qwen3-VL inference on the camera host.
3. **Tailscale HTTP boundary:** carries authenticated text responses and bounded control requests, never raw frames.
4. **Hermes conversation route:** receives local textual observations and any prompt bodies sent through agent tools. A cloud-backed route can transmit that text off the camera host; Hermes may retain ordinary tool arguments/results in state and logs.
5. **Physical boundary:** USB unplug or a switched USB data port overrides every software claim.

## Enforced controls

- Manual process launch only, no autostart.
- Hard finite lease of 1 to 10,080 minutes (seven days).
- No agent-facing start or arm route.
- Separate 256-bit-class random bearer tokens for each configured principal, each bound to its observed Tailscale source address.
- Timing-safe token comparison.
- Bind validation permits only loopback or `100.64.0.0/10`.
- No CORS and redirects forbidden in clients.
- Request bodies and prompt-client responses capped at 128 KiB; the complete prompt remains capped at 16,000 UTF-16 code units.
- One serialized physical camera queue.
- Per-agent look cooldown and quota.
- PTZ lease plus forward-zone limits.
- Stop invalidates generations, aborts local vision, discards cancellation-resistant late results, and interrupts a blocked native snapshot by closing its helper before attempting a fresh-helper sleep.
- Raw capture uses only the in-memory snapshot helper.
- Vendor recording, preview, raw probe, and arbitrary command tools are unreachable.
- Local vision rejects non-loopback inference URLs.
- Media/data-URL/file-path/base64-like VLM output is rejected, and accepted scene text is structurally marked as untrusted observation data with a fresh-user-intent requirement for another camera action.
- Bridge operational logging is content-free and canonicalizes unknown routes. Hermes tool/session logging is a separate boundary and can retain prompt bodies used through agent tools.
- The bridge holds only the current prompt in process memory; bridge revision history stores metadata and hashes, never prior prompt bodies. Agent tool arguments/results are not ephemeral and follow Hermes retention.
- Every prompt mutation requires the current expected revision, preventing silent concurrent overwrite.

## Not guaranteed

- A user or process with full control of the camera host can access the USB camera independently of this bridge.
- The Tiny 2 firmware, Windows camera stack, GPU driver, Ollama, and OS are trusted dependencies.
- Hard process termination or power loss may prevent graceful gimbal parking. Unplug when physical certainty is required.
- The camera hardware LED and gimbal position are useful indicators but are not cryptographic proof.
- A local vision description can be imperfect or hallucinated. It is observation evidence, not ground truth.
- Text returned to a cloud-routed agent session may leave the camera host. Fully local semantics require selecting a local assistant route for that session.
- Prompt bodies obtained or changed through agent tools are ordinary Hermes conversation data and may persist in `state.db`, verbose logs, and a cloud-backed route. The operator's local editor avoids Hermes but still sends the prompt to the local bridge.
- Authorized prompt rewrites can intentionally remove or invert the default VLM behavioral and safety language. This is an explicit local experiment surface, not a bypass of the bridge's camera controls.
- Structural untrusted-data labeling and tool instructions reduce prompt-injection risk but cannot prove a model will never request another bounded camera action. Server quotas, cooldown, finite activation, PTZ bounds, and Stop remain the hard backstops.
- A seven-day process does not survive reboot, forced termination, Docker/Windows maintenance, or power loss. The visible activation console must remain running.

## Explicitly out of scope

- Continuous video or ambient monitoring
- Audio capture
- A dedicated biometric identification or medical-diagnostic service; a deliberately permissive VLM prompt may still produce fallible sensitive inferences as text
- Covert startup
- Automatic reactivation after stop, reboot, or expiry
- Matrix or A2A image transport
- Cloud vision
- Recording or historical frame archives
