import importlib.util
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
        self.assertIn("optional_env:", manifest)
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

    def test_plugin_requires_explicit_url_and_agent_and_keeps_token_file_fallback(self):
        plugin = load_plugin()
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(ValueError, "SHARED_CAMERA_URL"):
                plugin._get_client()
        with patch.dict(
            "os.environ",
            {"SHARED_CAMERA_URL": "http://100.64.0.10:8766"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "SHARED_CAMERA_AGENT"):
                plugin._get_client()
        with patch.dict(
            "os.environ",
            {
                "SHARED_CAMERA_URL": "http://100.64.0.10:8766",
                "SHARED_CAMERA_AGENT": "desk-cam_01",
                "SHARED_CAMERA_TOKEN_FILE": "/tmp/agent-camera-token",
            },
            clear=True,
        ):
            client = plugin._get_client()
        self.assertEqual(client._expected_agent, "desk-cam_01")
        self.assertEqual(client._base_url, "http://100.64.0.10:8766")
        self.assertEqual(client._token_file, Path("/tmp/agent-camera-token"))

        with patch.object(plugin.Path, "home", return_value=Path("/synthetic-home")):
            with patch.dict(
                "os.environ",
                {
                    "SHARED_CAMERA_URL": "http://127.0.0.1:8766",
                    "SHARED_CAMERA_AGENT": "ops",
                },
                clear=True,
            ):
                client = plugin._get_client()
        self.assertEqual(client._expected_agent, "ops")
        self.assertEqual(
            client._token_file,
            Path("/synthetic-home") / ".config" / "shared-camera" / "token",
        )

    def test_plugin_rejects_normalized_or_mistyped_agent_identity(self):
        plugin = load_plugin()
        with patch.dict(
            "os.environ",
            {
                "SHARED_CAMERA_URL": "http://127.0.0.1:8766",
                "SHARED_CAMERA_AGENT": "Agent_A",
                "SHARED_CAMERA_TOKEN_FILE": "/tmp/invalid-agent-token",
            },
            clear=True,
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
