# Security policy

This project controls a physical camera. Treat security and privacy defects as safety defects.

## Reporting a vulnerability

When the GitHub repository enables private vulnerability reporting, use **Security → Report a vulnerability**. Do not open a public issue for a flaw that could expose camera frames, credentials, local endpoints, physical-control state, or a way to bypass consent, Stop, expiry, source binding, or PTZ limits.

Do not attach:

- real camera frames or recordings;
- bearer tokens or private configuration;
- public or private IP addresses from a real deployment;
- logs containing prompt bodies or scene descriptions;
- crash dumps from a live camera session.

A useful report includes the affected commit, operating system, OBSBOT model, Hermes version if relevant, minimal reproduction steps using synthetic data, and the expected versus observed privacy invariant.

## Security boundary

Read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) before deploying. Important limits include:

- the bridge does not protect against an administrator or other local process that independently opens the camera;
- raw frames are intended to stay in host process memory and the loopback vision request;
- derived text and shared-prompt bodies can enter Hermes session storage or a cloud-backed model route;
- physical USB disconnection is the strongest off state;
- software tests do not replace supervised physical acceptance on each host and camera.

## Supported versions

Until tagged releases exist, only the latest commit on the default branch is supported. Deploy by immutable commit rather than a moving branch.
