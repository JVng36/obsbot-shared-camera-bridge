# Hermes shared-camera plugin

The plugin requires the supported `agent.secret_scope.get_secret(name, default=None)`
API. Each tool dispatch resolves these values from the current Hermes profile context:

- `SHARED_CAMERA_URL`: bridge URL accepted by the existing client.
- `SHARED_CAMERA_AGENT`: exact authorized principal ID.
- `SHARED_CAMERA_TOKEN_FILE`: explicit pointer to that profile's token file.

All three values are required. The plugin does not read process environment variables
or use a shared home-directory token default. A scoped miss, unavailable API, or scoped
lookup exception fails before client construction. Lookup exceptions produce a generic
message without exposing their underlying details. Hermes must establish the correct
profile context before dispatch, including multiplexed and routed-profile requests.

Tool names, schemas, prompt handlers, and camera consent behavior remain unchanged.
This plugin change does not configure or deploy a running Hermes instance.

Run the focused offline plugin tests from the repository root:

```sh
PYTHONPATH=clients/hermes-plugin python3 -m unittest discover -s clients/hermes-plugin/tests -p test_plugin.py
```

Profile lookup tests use synthetic modules/context mappings and a fake client; they
read no real token files and make no network requests. The full gate omits `-p test_plugin.py`. Existing client coverage includes an owned
loopback HTTP server and synthetic temporary token files. The full suite requires a
runtime that permits owned loopback listeners.
