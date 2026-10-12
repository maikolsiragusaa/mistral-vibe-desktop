"""Small JSON-lines bridge to Vibe's official delegated browser authentication."""

from __future__ import annotations

import asyncio
from contextlib import redirect_stdout
from enum import Enum
import json
import sys
from typing import Any


MAX_LINE_LENGTH = 16_384


def _safe_auth_state(controller: Any) -> dict[str, Any]:
    state = controller.status()
    kind = state.kind.value if isinstance(state.kind, Enum) else str(state.kind)
    return {
        "kind": kind,
        "canUseActiveProvider": bool(state.can_use_active_provider),
        "signOutAvailable": bool(state.sign_out_available),
    }


def _project_result(controller: Any, request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action == "status":
        with redirect_stdout(sys.stderr):
            return {"auth": _safe_auth_state(controller)}

    if action not in {"begin", "complete"}:
        raise ValueError("Unsupported action")

    arguments: dict[str, str] = {
        "action": "start" if action == "begin" else "complete",
    }
    if action == "complete":
        attempt_id = request.get("attemptId")
        if not isinstance(attempt_id, str) or not attempt_id or len(attempt_id) > 256:
            raise ValueError("Invalid attempt")
        arguments["attemptId"] = attempt_id

    with redirect_stdout(sys.stderr):
        response = asyncio.run(
            controller.authenticate("browser-auth-delegated", arguments)
        )
    meta = response.field_meta.get("browser-auth-delegated", {})
    if action == "begin":
        attempt_id = meta.get("attemptId")
        expires_at = meta.get("expiresAt")
        sign_in_url = meta.get("signInUrl")
        if not all(isinstance(value, str) and value for value in (attempt_id, expires_at, sign_in_url)):
            raise ValueError("Invalid sign-in response")
        return {
            "attemptId": attempt_id,
            "expiresAt": expires_at,
            "signInUrl": sign_in_url,
        }

    if meta.get("status") != "completed":
        raise ValueError("Sign-in did not complete")
    # Explicitly whitelist persistence results. The delegated controller never
    # returns the API key, but the bridge still refuses unknown metadata.
    result = {"attemptId": attempt_id, "status": "completed"}
    for name in (
        "persistResult",
        "persistProviderResult",
        "persistConsoleBaseUrlResult",
        "persistVibeBaseUrlResult",
    ):
        value = meta.get(name)
        if isinstance(value, str):
            result[name] = value
    return result


def _new_controller() -> Any:
    from vibe.acp.auth import AcpAuthController

    return AcpAuthController()


def main() -> int:
    controller = _new_controller()
    for raw_line in sys.stdin:
        request_id = ""
        action = None
        if len(raw_line) > MAX_LINE_LENGTH:
            break
        try:
            request = json.loads(raw_line)
            if not isinstance(request, dict):
                raise ValueError("Invalid request")
            candidate_id = request.get("id")
            request_id = candidate_id if isinstance(candidate_id, str) and len(candidate_id) <= 128 else ""
            action = request.get("action")
            if (
                not isinstance(request_id, str)
                or not request_id
                or len(request_id) > 128
                or action not in {"status", "begin", "complete"}
                or set(request) - {"id", "action", "attemptId"}
                or (action == "complete" and "attemptId" not in request)
                or (action != "complete" and "attemptId" in request)
            ):
                raise ValueError("Invalid request")
            result = _project_result(controller, request)
            response = {"id": request_id, "result": result}
        except Exception:
            # Never send exception text: upstream failures can contain local
            # configuration details. The renderer receives only a fixed code.
            code = "AUTH_STATUS_FAILED" if action == "status" else "BROWSER_SIGN_IN_FAILED"
            response = {"id": request_id, "error": {"code": code}}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
