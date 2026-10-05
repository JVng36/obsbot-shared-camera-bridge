"""Offline independent launcher probes. All children are synthetic; no vendor imports."""
import json
import os
import pty
import select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = []


def launch(args, env, answer=b"START\n", expected_prompt=True):
    master, slave = pty.openpty()
    proc = subprocess.Popen(["/bin/bash", str(ROOT / "scripts/start-shared-camera.sh"), *args], stdin=slave, stdout=slave, stderr=slave, cwd=ROOT, env=env)
    os.close(slave)
    output = b""
    answered = False
    duration_answered = False
    try:
        until = time.monotonic() + 8
        while time.monotonic() < until:
            if select.select([master], [], [], .05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                output += chunk
                if b"Session duration in minutes" in output and not duration_answered:
                    os.write(master, b"\n")
                    duration_answered = True
                if b"Type START" in output and not answered:
                    os.write(master, answer)
                    answered = True
            if proc.poll() is not None:
                break
        status = proc.wait(timeout=2)
        if expected_prompt:
            assert answered, output
        return status, output.decode(errors="replace")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix="fix1-launcher-") as temp:
    temp = Path(temp)
    env = {"PATH": os.environ["PATH"], "TMPDIR": str(temp)}
    node = shutil.which("node")
    preload = temp / "preload.cjs"
    preload.write_text("console.log('FIX1_PRELOAD_EXECUTED');process.exit(0)")
    args = ["--node", node, "--config", str(temp / "missing.json"), "--vendor-root", str(temp / "NO_VENDOR")]
    status, output = launch(args, {**env, "NODE_OPTIONS": "--require=" + str(preload)})
    assert status != 0 and "rejected" in output and "FIX1_PRELOAD_EXECUTED" not in output, (status, output)
    names = ['NODE_OPTIONS','NODE_PATH','NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','OPENSSL_CONF','OPENSSL_MODULES','NODE_EXTRA_CA_CERTS','node_options','node_path','node_use_env_proxy','ld_preload','ld_library_path','ld_audit','NODE_V8_COVERAGE','NODE_COMPILE_CACHE','NODE_REDIRECT_WARNINGS','SSLKEYLOGFILE']
    fake = temp / "fake node"
    fake.write_text("#!/usr/bin/python3\nimport os,resource\nassert not any(k in os.environ for k in " + repr(names) + ")\nassert resource.getrlimit(resource.RLIMIT_CORE)[0] == 0\nprint('FIX1_SANITIZED')\n")
    fake.chmod(0o700)
    status, output = launch(["--node", str(fake)], {**env, **dict.fromkeys(names, '/missing-fix1-synthetic')})
    assert status == 0 and 'FIX1_SANITIZED' in output, (status, output)
print('SC-1 real PTY preload/config and fake executable environment/core checks passed')
