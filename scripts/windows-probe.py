"""Exercise the real upstream stdio process without model calls or user credentials."""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time


def main() -> None:
    executable = sys.argv[1] if len(sys.argv) > 1 else "vibe-app-server"
    executable_path = Path(executable).resolve()
    builtin_root = executable_path.parent / "_internal" / "vibe" / "plugins" / "builtins"
    required_builtin_files = (
        builtin_root / "vibe" / "plugin.json",
        builtin_root / "vibe" / "skills" / "vibe" / "SKILL.md",
        builtin_root / "vibe" / "skills" / "worktree" / "SKILL.md",
    )
    if not builtin_root.is_dir() or any(not path.is_file() for path in required_builtin_files):
        raise AssertionError(
            "Frozen backend is missing built-in plugin resources under "
            f"{builtin_root}"
        )
    with tempfile.TemporaryDirectory(prefix="vibe-desktop-probe-") as home:
        Path(home, "config.toml").write_text('enable_telemetry = false\nenable_update_checks = false\nactive_model = "local"\n[[models]]\nname = "protocol-test"\nalias = "local"\nprovider = "llamacpp"\n', encoding="utf-8")
        env = dict(os.environ, VIBE_HOME=home, MISTRAL_API_KEY="", DO_NOT_TRACK="1")
        process = subprocess.Popen(
            [executable], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", env=env,
        )
        incoming: queue.Queue[dict] = queue.Queue()
        errors: list[str] = []
        def read() -> None:
            assert process.stdout
            for line in process.stdout:
                try:
                    incoming.put(json.loads(line))
                except json.JSONDecodeError:
                    errors.append("Non-JSON stdout")
        def stderr() -> None:
            assert process.stderr
            for line in process.stderr:
                errors.append(line.rstrip())
        threading.Thread(target=read, daemon=True).start()
        threading.Thread(target=stderr, daemon=True).start()
        serial = 0
        def request(method: str, params: dict) -> dict:
            nonlocal serial
            serial += 1
            assert process.stdin
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": serial, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                message = incoming.get(timeout=max(0.1, deadline - time.monotonic()))
                if message.get("id") == serial:
                    return message
            raise RuntimeError(f"Timed out: {method}")
        def result(response: dict, method: str) -> dict:
            if response.get("jsonrpc") != "2.0":
                raise AssertionError(f"{method} returned an invalid JSON-RPC envelope: {response!r}")
            if "error" in response:
                raise AssertionError(f"{method} returned a JSON-RPC error: {response['error']!r}")
            value = response.get("result")
            if not isinstance(value, dict):
                raise AssertionError(f"{method} did not return an object result: {response!r}")
            return value
        try:
            initialization = request("initialize", {"clientInfo": {"name": "vibe-desktop-probe", "version": "0.1.0"}, "capabilities": {"callbackKinds": ["approval", "user_input"]}})
            server_info = result(initialization, "initialize").get("serverInfo")
            if not isinstance(server_info, dict) or server_info.get("name") != "vibe-app-server" or server_info.get("version") != "2.26.1":
                raise AssertionError(f"Unexpected app-server identity: {server_info!r}")
            assert process.stdin
            process.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n')
            process.stdin.flush()
            result(request("setup/status", {}), "setup/status")
            catalogue = result(request("session/list", {"limit": 10}), "session/list")
            if not isinstance(catalogue.get("items"), list):
                raise AssertionError(f"session/list omitted its item list: {catalogue!r}")
            trust = result(request("workspace/trust/status", {"cwd": str(Path.cwd())}), "workspace/trust/status")
            if trust.get("status") not in {"trusted", "untrusted"}:
                raise AssertionError(f"Unexpected workspace trust status: {trust!r}")
            start = result(request("session/start", {"agentConfig": {"cwd": str(Path.cwd()), "agent": "plan"}}), "session/start")
            state = start.get("state")
            session = state.get("session") if isinstance(state, dict) else None
            session_id = session.get("id") if isinstance(session, dict) else None
            if not isinstance(session_id, str) or not session_id:
                raise AssertionError(f"session/start did not return a session id: {start!r}")
            runtime = result(request("runtime/read", {"sessionId": session_id}), "runtime/read")
            if runtime.get("ready") is not True or runtime.get("error") is not None:
                raise AssertionError(f"Unified Runtime did not report ready: {runtime!r}")
            runtime_snapshot = runtime.get("runtime")
            issues = runtime_snapshot.get("issues") if isinstance(runtime_snapshot, dict) else None
            if not isinstance(issues, list):
                raise AssertionError(f"runtime/read omitted its issue list: {runtime!r}")
            builtin_discovery_errors = [
                issue
                for issue in issues
                if isinstance(issue, dict)
                and "failed to discover:" in str(issue.get("message", "")).casefold()
                and "vibe/plugins/builtins" in str(issue.get("message", "")).replace("\\", "/").casefold()
            ]
            if builtin_discovery_errors:
                raise AssertionError(
                    "Frozen backend could not discover its packaged built-in plugins: "
                    f"{builtin_discovery_errors!r}"
                )
            stopped = result(request("session/stop", {"sessionId": session_id}), "session/stop")
            if stopped.get("closed") is not True:
                raise AssertionError(f"session/stop did not close the session: {stopped!r}")
            report = {
                "platform": sys.platform,
                "serverInfo": server_info,
                "setupStatus": "responded",
                "catalogueItems": len(catalogue["items"]),
                "trustStatus": trust["status"],
                "sessionStarted": True,
                "runtimeReady": True,
                "runtimeIssueCount": len(issues),
                "builtinPluginResources": len(required_builtin_files),
                "sessionStopped": True,
                "modelCalls": 0,
                "isolatedHome": True,
            }
            print(json.dumps(report, indent=2))
        finally:
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            if process.returncode:
                print("Server diagnostics:", "\n".join(errors[-8:]), file=sys.stderr)


if __name__ == "__main__":
    main()
