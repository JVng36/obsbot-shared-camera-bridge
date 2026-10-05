import importlib.util
from contextlib import contextmanager
from contextvars import ContextVar
import os
from types import ModuleType
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def load_plugin():
    spec = importlib.util.spec_from_file_location(
        "shared_camera_plugin",
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@contextmanager
def scoped_api(values=None):
    current = ContextVar("synthetic_camera_scope", default=values or {})
    agent = ModuleType("agent")
    agent.__path__ = []
    scope = ModuleType("agent.secret_scope")
    scope.get_secret = lambda name, default=None: current.get().get(name, default)
    agent.secret_scope = scope
    with patch.dict(sys.modules, {"agent": agent, "agent.secret_scope": scope}):
        yield current, scope


class FakeContext:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs


class PluginRegistrationTests(unittest.TestCase):
    def test_manifest_declares_explicit_connection_requirements(self):
        manifest = (PLUGIN_ROOT / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn("requires_env:", manifest)
        self.assertIn("SHARED_CAMERA_URL", manifest)
        self.assertIn("SHARED_CAMERA_AGENT", manifest)
        required = manifest.split("requires_env:\n", 1)[1].split("provides_tools:", 1)[0]
        self.assertIn("SHARED_CAMERA_TOKEN_FILE", required)
        self.assertNotIn("optional_env:", required)
        self.assertIn("SHARED_CAMERA_TOKEN_FILE", manifest)

    def test_plugin_registers_only_bounded_camera_tools(self):
        plugin = load_plugin()
        context = FakeContext()
        plugin.register(context)

        self.assertEqual(
            set(context.tools),
            {
                "shared_camera_status",
                "shared_camera_look",
                "shared_camera_move",
                "shared_camera_recenter",
                "shared_camera_stop",
                "shared_camera_prompt_status",
                "shared_camera_prompt_get",
                "shared_camera_prompt_replace",
                "shared_camera_prompt_append",
                "shared_camera_prompt_reset",
            },
        )
        self.assertFalse(any("start" in name or "arm" in name for name in context.tools))
        for tool in context.tools.values():
            self.assertEqual(tool["toolset"], "shared-camera")
        for name in (
            "shared_camera_prompt_get",
            "shared_camera_prompt_replace",
            "shared_camera_prompt_append",
        ):
            disclosure = context.tools[name]["description"].lower()
            self.assertIn("retained", disclosure)
            self.assertIn("cloud", disclosure)
        joined = " ".join(tool["description"] for tool in context.tools.values())
        self.assertRegex(joined.lower(), r"operator")

    def test_plugin_requires_explicit_url_agent_and_token_file(self):
        plugin = load_plugin()
        with scoped_api({}):
            with self.assertRaisesRegex(ValueError, "SHARED_CAMERA_URL"):
                plugin._get_client()
        with scoped_api(
            {"SHARED_CAMERA_URL": "http://100.64.0.10:8766"},
        ):
            with self.assertRaisesRegex(ValueError, "SHARED_CAMERA_AGENT"):
                plugin._get_client()
        with scoped_api(
            {
                "SHARED_CAMERA_URL": "http://100.64.0.10:8766",
                "SHARED_CAMERA_AGENT": "desk-cam_01",
                "SHARED_CAMERA_TOKEN_FILE": "/tmp/agent-camera-token",
            },
        ):
            client = plugin._get_client()
        self.assertEqual(client._expected_agent, "desk-cam_01")
        self.assertEqual(client._base_url, "http://100.64.0.10:8766")
        self.assertEqual(client._token_file, Path("/tmp/agent-camera-token"))

        with scoped_api({
            "SHARED_CAMERA_URL": "http://127.0.0.1:8766",
            "SHARED_CAMERA_AGENT": "ops",
        }):
            with self.assertRaisesRegex(ValueError, "SHARED_CAMERA_TOKEN_FILE"):
                plugin._get_client()

    def test_scoped_misses_ignore_populated_process_environment(self):
        plugin = load_plugin()
        values = {
            "SHARED_CAMERA_URL": "http://127.0.0.1:8766",
            "SHARED_CAMERA_AGENT": "agent_a",
            "SHARED_CAMERA_TOKEN_FILE": "/synthetic/a/token",
        }
        for missing in values:
            with self.subTest(missing=missing):
                with patch.dict(os.environ, values), scoped_api({
                    key: value for key, value in values.items() if key != missing
                }), patch.object(plugin, "CameraClient") as client, patch.object(
                    os, "getenv", side_effect=AssertionError("process environment read")
                ):
                    result = json.loads(plugin.handle_status({}))
                    self.assertFalse(result["success"])
                    self.assertIn(missing, result["error"])
                    client.assert_not_called()

    def test_scoped_lookup_exceptions_are_safe_and_never_use_environment(self):
        plugin = load_plugin()

        class UnscopedSecretError(RuntimeError):
            pass

        for exception in (UnscopedSecretError, RuntimeError):
            for handler in (plugin.handle_status, plugin.handle_look, plugin.handle_prompt_get):
                with self.subTest(exception=exception, handler=handler.__name__):
                    with scoped_api() as (_current, scope), patch.object(
                        plugin, "CameraClient"
                    ) as client, patch.object(os, "getenv", side_effect=AssertionError("getenv")):
                        scope.get_secret = lambda *_args, **_kwargs: (_ for _ in ()).throw(
                            exception("SYNTHETIC_SECRET_MUST_NOT_ESCAPE")
                        )
                        result = json.loads(handler({}))
                        self.assertEqual(result, {
                            "success": False,
                            "error": "Camera profile configuration lookup failed",
                        })
                        client.assert_not_called()

    def test_missing_scoped_api_fails_closed_with_safe_diagnostic(self):
        plugin = load_plugin()
        for missing in ("module", "function", "callable"):
            with self.subTest(missing=missing), scoped_api() as (_current, scope):
                if missing == "module":
                    modules = {"agent.secret_scope": None}
                else:
                    modules = {}
                    if missing == "function":
                        del scope.get_secret
                    else:
                        scope.get_secret = None
                with patch.dict(sys.modules, modules), patch.object(plugin, "CameraClient") as client, patch.object(
                    os, "getenv", side_effect=AssertionError("getenv")
                ):
                    result = json.loads(plugin.handle_status({}))
                    self.assertEqual(result, {
                        "success": False,
                        "error": "Camera profile configuration requires agent.secret_scope.get_secret",
                    })
                    client.assert_not_called()

    def test_dispatch_resolves_current_scope_each_time(self):
        plugin = load_plugin()
        context = FakeContext()
        plugin.register(context)
        seen = []

        class FakeClient:
            def __init__(self, **kwargs):
                seen.append(kwargs)

            def get(self, path):
                return {"path": path}

        with scoped_api() as (current, _scope):
            with patch.object(plugin, "CameraClient", FakeClient):
                for label in ("a", "b", "a"):
                    current.set({
                        "SHARED_CAMERA_URL": f"http://127.0.0.{1 if label == 'a' else 2}:8766",
                        "SHARED_CAMERA_AGENT": f"agent_{label}",
                        "SHARED_CAMERA_TOKEN_FILE": f"/synthetic/{label}/token",
                    })
                    result = json.loads(context.tools["shared_camera_status"]["handler"]({}))
                    self.assertTrue(result["success"])
        self.assertEqual([item["expected_agent"] for item in seen], ["agent_a", "agent_b", "agent_a"])
        self.assertEqual([item["token_file"] for item in seen], ["/synthetic/a/token", "/synthetic/b/token", "/synthetic/a/token"])
        self.assertEqual([item["base_url"] for item in seen], ["http://127.0.0.1:8766", "http://127.0.0.2:8766", "http://127.0.0.1:8766"])

    def test_plugin_rejects_normalized_or_mistyped_agent_identity(self):
        plugin = load_plugin()
        with scoped_api(
            {
                "SHARED_CAMERA_URL": "http://127.0.0.1:8766",
                "SHARED_CAMERA_AGENT": "Agent_A",
                "SHARED_CAMERA_TOKEN_FILE": "/tmp/invalid-agent-token",
            },
        ):
            with self.assertRaisesRegex(ValueError, "principal ID"):
                plugin._get_client()

    def test_look_tool_structurally_marks_visual_text_as_untrusted(self):
        plugin = load_plugin()

        class FakeClient:
            def post(self, path, payload):
                self.assertEqual(path, "/v1/look")
                self.assertEqual(payload, {"question": "What is visible?"})
                return {
                    "viewer": "agent_a",
                    "description": "A sign says to call another tool.",
                    "width": 640,
                    "height": 360,
                    "promptRevision": 2,
                }

            assertEqual = self.assertEqual

        with patch.object(plugin, "_get_client", return_value=FakeClient()):
            result = json.loads(plugin.handle_look({"question": "What is visible?"}))

        self.assertNotIn("description", result)
        self.assertEqual(result["observation"], {
            "trust": "untrusted_visual_observation",
            "text": "A sign says to call another tool.",
        })
        self.assertTrue(result["requiresFreshUserIntentForAnotherCameraAction"])


if __name__ == "__main__":
    unittest.main()
