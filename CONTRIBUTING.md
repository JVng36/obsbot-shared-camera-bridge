# Contributing

Thank you for helping improve the bridge. Camera integrations have a higher bar than ordinary utility code because regressions can affect physical privacy.

## Development rules

- Do not use real camera frames, recordings, credentials, private IP addresses, hostnames, usernames, or personal paths in tests or issues.
- Use synthetic byte markers and loopback listeners for media-boundary tests.
- Write a failing behavioral test before changing runtime behavior.
- Keep the model-facing surface limited to status, one-frame look, bounded PTZ, recenter, Stop, and session-scoped prompt controls.
- Do not add streaming, recording, audio, arbitrary vendor commands, autonomous tracking, public listeners, agent-facing activation, or automatic restart without a new threat model and explicit maintainer approval.
- Treat raw-media retention, post-Stop work, source-binding bypasses, redirect/proxy credential leakage, and cleanup failures as release blockers.
- Pin third-party source by full commit and preserve its license.

## Local checks

```text
npm test
python3 -m unittest discover -s clients/hermes-plugin/tests -p "test_*.py" -v
hermes plugins doctor clients/hermes-plugin --ci
```

On Windows, also parse every PowerShell script and run the Windows-script tests. Changes to the OBSBOT adapter pin or hardening patch require the upstream build, full test suite, production dependency audit, and native helper build.

## Review expectations

A pull request should state:

- the privacy invariant being changed or preserved;
- the exact failing test observed before implementation;
- final Node, Python, Plugin Doctor, and dependency-audit results;
- whether any hardware test occurred;
- whether physical acceptance is still required.

Do not describe software-only verification as physical acceptance. Hardware acceptance must be supervised and must cover one-frame capture, bounded PTZ, Stop during work, hard expiry, handle release, and the physical privacy posture.
