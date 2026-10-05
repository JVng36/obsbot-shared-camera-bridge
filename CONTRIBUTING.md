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

## Source of truth and deployment

GitHub is the development source of truth. Develop on a feature branch from the
current upstream main, publish portable source and synthetic tests, and submit a
pull request. Keep machine-specific configuration, credentials, handoffs, raw or
derived observations, and deployment evidence outside the public tree. Do not
use an installed vendor directory as an unpublished development branch.

Keep source publication, merge, and deployment separate. After review and merge,
a separately authorized deployment must pin an exact Git commit, reconstruct the
adapter from `vendor.lock.json` and its ordered patches, run offline checks, and
retain the previous deployment for rollback. Do not restart or activate a camera
as a side effect of pulling source. Preserve private configuration independently;
never commit it to make an installation reproducible.

For Linux prerequisites, clean reconstruction and synthetic native tests, see
[docs/LINUX.md](docs/LINUX.md). The launcher default is 30 minutes; the hard cap is
seven days. Source updates do not alter an already running session's deadline.

## Local checks

```text
npm test
python3 -m unittest discover -s clients/hermes-plugin/tests -p "test_*.py" -v
hermes plugins doctor clients/hermes-plugin --ci
```

Set `PYTHONPATH=clients/hermes-plugin` before Python discovery (on PowerShell,
`$env:PYTHONPATH = 'clients/hermes-plugin'`). CI sets this explicitly.

On Windows, also parse every PowerShell script and run the Windows-script tests. Changes to the OBSBOT adapter pin or hardening patch require the upstream build, full test suite, production dependency audit, and native helper build.

## Review expectations

A pull request should state:

- the privacy invariant being changed or preserved;
- the exact failing test observed before implementation;
- final Node, Python, Plugin Doctor, and dependency-audit results;
- whether any hardware test occurred;
- whether physical acceptance is still required.

Do not describe software-only verification as physical acceptance. Hardware acceptance must be supervised and must cover one-frame capture, bounded PTZ, Stop during work, hard expiry, handle release, and the physical privacy posture.
