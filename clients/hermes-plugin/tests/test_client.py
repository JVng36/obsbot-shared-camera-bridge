import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from io import BytesIO
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import threading
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler

import client as client_module
from client import CameraClient

OBSERVATION_VECTORS = json.loads(
    (Path(__file__).resolve().parents[1] / "observation-text-vectors.json")
    .read_text(encoding="utf-8")
)


class FakeResponse:
    def __init__(self, payload, status=200, content_type="application/json"):
        self._payload = json.dumps(payload).encode("utf-8")
        self.status = status
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit):
        return self._payload[:limit]


class CameraClientTests(unittest.TestCase):
    def test_default_opener_disables_environment_proxies(self):
        with patch.dict(
            os.environ,
            {
                "HTTP_PROXY": "http://127.0.0.1:65534",
                "http_proxy": "http://127.0.0.1:65534",
            },
            clear=False,
        ):
            unsafe_opener = client_module.build_opener(client_module._NoRedirect())
            opener = client_module._build_no_proxy_opener()
        unsafe_proxies = [
            handler.proxies
            for handler in unsafe_opener.handlers
            if isinstance(handler, ProxyHandler)
        ]
        self.assertTrue(any(proxies for proxies in unsafe_proxies))
        configured_proxies = [
            handler.proxies
            for handler in opener.handlers
            if isinstance(handler, ProxyHandler)
        ]
        self.assertTrue(all(proxies == {} for proxies in configured_proxies))

    def test_request_uses_token_file_and_returns_only_json(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            fake_token = "x" * 43
            token_file.write_text(fake_token, encoding="utf-8")
            seen = {}

            def fake_urlopen(request, timeout):
                seen["url"] = request.full_url
                seen["authorization"] = request.headers["Authorization"]
                seen["body"] = json.loads(request.data)
                seen["timeout"] = timeout
                return FakeResponse({
                    "viewer": "agent_a",
                    "description": "A person is seated.",
                    "width": 640,
                    "height": 360,
                    "promptRevision": 0,
                })

            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=fake_urlopen,
                expected_agent="agent_a",
            )
            result = client.post("/v1/look", {"question": "What is visible?"})

            self.assertEqual(result["description"], "A person is seated.")
            self.assertEqual(seen["url"], "http://100.64.0.10:8766/v1/look")
            self.assertEqual(seen["authorization"], f"Bearer {fake_token}")
            self.assertEqual(seen["body"], {"question": "What is visible?"})
            self.assertEqual(seen["timeout"], 75)

    def test_client_refuses_non_private_bridge_urls(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            for url in ["https://camera.example.com", "http://192.168.1.170:8766", "http://0.0.0.0:8766"]:
                with self.subTest(url=url):
                    with self.assertRaisesRegex(ValueError, "loopback or Tailscale"):
                        CameraClient(base_url=url, token_file=token_file)

    def test_client_rejects_successful_json_with_non_json_content_type(self):
        payload = {
            "active": True,
            "expiresAtMs": 2000,
            "reason": None,
            "ptzLeaseHolder": None,
            "ptzLeaseExpiresAtMs": None,
            "promptRevision": 0,
            "promptUpdatedAtMs": 1000,
            "promptUpdatedBy": "system",
            "promptAction": "initial",
            "promptChars": 10,
            "promptSha256": "a" * 64,
        }

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, _format, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as temp_dir:
                token_file = Path(temp_dir) / "token"
                token_file.write_text("x" * 43, encoding="utf-8")
                client = CameraClient(
                    base_url=f"http://127.0.0.1:{server.server_port}",
                    token_file=token_file,
                    expected_agent="agent_a",
                )
                with self.assertRaisesRegex(RuntimeError, "content type"):
                    client.get("/v1/status")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_client_rejects_unexpected_image_fields(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")

            def fake_urlopen(_request, timeout):
                self.assertEqual(timeout, 75)
                return FakeResponse({
                    "viewer": "agent_a",
                    "description": "Text is permitted.",
                    "base64": "PRIVATE_IMAGE_MUST_NOT_ESCAPE",
                    "promptRevision": 0,
                })

            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=fake_urlopen,
            )
            with self.assertRaisesRegex(RuntimeError, "unexpected response fields"):
                client.post("/v1/look", {"question": "What is visible?"})

    def test_client_rejects_nested_image_data_in_allowed_fields(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")

            def fake_urlopen(_request, timeout):
                self.assertEqual(timeout, 75)
                return FakeResponse({
                    "viewer": "agent_a",
                    "description": {"base64": "PRIVATE_NESTED_IMAGE"},
                    "width": 640,
                    "height": 360,
                    "promptRevision": 0,
                })

            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=fake_urlopen,
            )
            with self.assertRaisesRegex(RuntimeError, "invalid response field types"):
                client.post("/v1/look", {"question": "What is visible?"})

    def test_http_error_does_not_forward_server_detail(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")

            def fake_urlopen(request, timeout):
                self.assertEqual(timeout, 75)
                body = BytesIO(json.dumps({
                    "error": {"base64": "PRIVATE_ERROR_IMAGE"},
                }).encode("utf-8"))
                raise HTTPError(request.full_url, 500, "failure", {}, body)

            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=fake_urlopen,
            )
            with self.assertRaises(RuntimeError) as caught:
                client.post("/v1/look", {"question": "What is visible?"})
            self.assertEqual(str(caught.exception), "camera bridge HTTP 500: request rejected")
            self.assertNotIn("PRIVATE_ERROR_IMAGE", str(caught.exception))

    def test_client_accepts_strict_prompt_get_with_bounded_metadata_history(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            prompt = "x" * 5_000
            digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
            payload = {
                "revision": 0,
                "updatedAtMs": 1000,
                "updatedBy": "system",
                "action": "initial",
                "chars": len(prompt),
                "sha256": digest,
                "history": [{
                    "revision": 0,
                    "updatedAtMs": 1000,
                    "updatedBy": "system",
                    "action": "initial",
                    "chars": len(prompt),
                    "sha256": digest,
                }],
                "prompt": prompt,
            }

            def fake_urlopen(_request, timeout):
                self.assertEqual(timeout, 75)
                return FakeResponse(payload)

            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=fake_urlopen,
            )
            result = client.get("/v1/prompt/get")
            self.assertEqual(result, payload)

    def test_client_rejects_invalid_identity_ranges_json_and_media_text(self):
        valid = {
            "viewer": "agent_a",
            "description": "A person is seated.",
            "width": 640,
            "height": 360,
            "promptRevision": 0,
        }
        invalid_payloads = [
            {**valid, "viewer": "agent_b"},
            {**valid, "width": -1},
            {**valid, "height": float("nan")},
            {**valid, "promptRevision": -1},
            *(
                {**valid, "description": description}
                for description in OBSERVATION_VECTORS["forbidden"]
            ),
        ]

        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    client = CameraClient(
                        base_url="http://100.64.0.10:8766",
                        token_file=token_file,
                        open_impl=lambda _request, timeout, value=payload: FakeResponse(value),
                        expected_agent="agent_a",
                    )
                    with self.assertRaises(RuntimeError):
                        client.post("/v1/look", {"question": "What is visible?"})

    def test_client_accepts_sixteen_thousand_escaped_prompt_characters(self):
        prompt = "\u0001" * 16_000
        digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        metadata = {
            "revision": 1,
            "updatedAtMs": 1000,
            "updatedBy": "operator",
            "action": "replace",
            "chars": 16_000,
            "sha256": digest,
        }
        payload = {**metadata, "history": [metadata], "prompt": prompt}

        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=lambda _request, timeout: FakeResponse(payload),
                expected_agent="agent_a",
            )
            self.assertEqual(client.get("/v1/prompt/get"), payload)

    def test_client_rejects_inconsistent_prompt_metadata_and_history(self):
        prompt = "Prompt body"
        digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        latest = {
            "revision": 1,
            "updatedAtMs": 1000,
            "updatedBy": "agent_a",
            "action": "replace",
            "chars": len(prompt),
            "sha256": digest,
        }
        valid = {**latest, "history": [latest], "prompt": prompt}
        invalid_payloads = [
            {**valid, "chars": len(prompt) + 1},
            {**valid, "sha256": "a" * 64},
            {**valid, "revision": -1},
            {**valid, "history": [{**latest, "revision": 0}]},
            {**valid, "history": [latest, latest]},
        ]

        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    client = CameraClient(
                        base_url="http://100.64.0.10:8766",
                        token_file=token_file,
                        open_impl=lambda _request, timeout, value=payload: FakeResponse(value),
                        expected_agent="agent_a",
                    )
                    with self.assertRaises(RuntimeError):
                        client.get("/v1/prompt/get")

    def test_client_accepts_arbitrary_valid_principal_ids(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            payload = {
                "viewer": "desk-cam_01",
                "description": "A person is seated.",
                "width": 640,
                "height": 360,
                "promptRevision": 0,
            }

            def fake_urlopen(_request, timeout):
                self.assertEqual(timeout, 75)
                return FakeResponse(payload)

            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=fake_urlopen,
                expected_agent="desk-cam_01",
            )
            self.assertEqual(client.post("/v1/look", {"question": "What is visible?"}), payload)

            prompt = "Prompt body"
            digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
            metadata = {
                "revision": 1,
                "updatedAtMs": 1000,
                "updatedBy": "ops",
                "action": "replace",
                "chars": len(prompt),
                "sha256": digest,
            }
            prompt_payload = {**metadata, "history": [metadata], "prompt": prompt}
            prompt_client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=lambda _request, timeout: FakeResponse(prompt_payload),
                expected_agent="desk-cam_01",
            )
            self.assertEqual(prompt_client.get("/v1/prompt/get"), prompt_payload)

    def test_client_rejects_invalid_and_reserved_principal_ids(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            for invalid in ["system", "Uppercase", "1agent", "AGENT", "has space", "bad.id", ""]:
                with self.subTest(invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "principal ID"):
                        CameraClient(
                            base_url="http://127.0.0.1:8766",
                            token_file=token_file,
                            expected_agent=invalid,
                        )

    def test_client_still_enforces_expected_agent_equality(self):
        with TemporaryDirectory() as temp_dir:
            token_file = Path(temp_dir) / "token"
            token_file.write_text("x" * 43, encoding="utf-8")
            payload = {
                "viewer": "agent_b",
                "description": "A person is seated.",
                "width": 640,
                "height": 360,
                "promptRevision": 0,
            }
            client = CameraClient(
                base_url="http://100.64.0.10:8766",
                token_file=token_file,
                open_impl=lambda _request, timeout: FakeResponse(payload),
                expected_agent="agent_a",
            )
            with self.assertRaises(RuntimeError):
                client.post("/v1/look", {"question": "What is visible?"})


if __name__ == "__main__":
    unittest.main()
