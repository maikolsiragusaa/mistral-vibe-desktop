"""Loopback OpenAI-compatible stream fixture for the desktop backend test."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import time


class FixtureState:
    requests = 0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        # Request bodies and headers can contain private prompt or credential data.
        return

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        body = json.dumps({"ready": True, "requests": FixtureState.requests}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 4 * 1024 * 1024:
            self.send_error(413)
            return
        # Consume request data without retaining, printing, or reflecting it.
        # Only the opt-in tool scenario parses tools/messages in memory so this
        # fixture can exercise Vibe's real approval and file-write path.
        subagent_scenario = os.environ.get("TEST_PROVIDER_SUBAGENT_SCENARIO") == "1"
        tool_scenario = os.environ.get("TEST_PROVIDER_TOOL_SCENARIO") == "1" or subagent_scenario
        request_body = self.rfile.read(length) if tool_scenario else None
        if request_body is None:
            self.rfile.read(length)
        FixtureState.requests += 1
        delay = max(0.0, min(float(os.environ.get("TEST_PROVIDER_DELAY_SECONDS", "0")), 10.0))
        if delay:
            time.sleep(delay)
        tool_call = None
        response_text = "Local fixture response."
        if tool_scenario:
            try:
                request = json.loads(request_body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.send_error(400)
                return
            messages = request.get("messages", []) if isinstance(request, dict) else []
            tools = request.get("tools", []) if isinstance(request, dict) else []
            if not isinstance(messages, list) or not isinstance(tools, list):
                self.send_error(400)
                return
            last_user_index = max(
                (index for index, message in enumerate(messages)
                 if isinstance(message, dict) and message.get("role") == "user"
                 and "Runtime notification:" not in json.dumps(message.get("content", ""))),
                default=-1,
            )
            last_user_text = json.dumps(messages[last_user_index].get("content", "")) if last_user_index >= 0 else ""
            if subagent_scenario and "Inspect the local fixture and report a short summary." in last_user_text:
                response_text = "Local subagent inspected the fixture."
            elif any(
                isinstance(message, dict) and message.get("role") == "tool"
                for message in messages[last_user_index + 1:]
            ):
                response_text = "Fixture file written."
            else:
                tool_name = next(
                    (
                        function.get("name")
                        for tool in tools
                        if isinstance(tool, dict)
                        and isinstance(tool.get("function"), dict)
                        and (function := tool["function"]).get("name")
                        in ({"run_typescript"} if subagent_scenario else {"write_file", "file_system.write_file"})
                    ),
                    None,
                )
                target = os.environ.get("TEST_PROVIDER_WRITE_PATH")
                # Unified exposes programmatic subagents through run_typescript.
                if subagent_scenario and not tool_name:
                    response_text = "Local subagent inspected the fixture."
                elif not tool_name or (not subagent_scenario and (not target or not os.path.isabs(target))):
                    self.send_error(503)
                    return
                if tool_name:
                    content = "Written by the isolated Vibe fixture.\n"
                    tool_call = {
                        "index": 0,
                        "id": "call-vibe-desktop-fixture-tool",
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(
                                {
                                    "code": "async function main() { "
                                    "await tools.subagent.spawn({agentName: 'fixture-explorer', "
                                    "message: 'Inspect the local fixture and report a short summary.'}); "
                                    "return await tools.subagent.wait({agentName: 'fixture-explorer', "
                                    "timeoutMs: 30000}); }"
                                } if subagent_scenario else {"path": target, "content": content},
                                separators=(",", ":"),
                            ),
                        },
                    }
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        first_delta = {"role": "assistant"}
        if tool_call:
            first_delta["tool_calls"] = [tool_call]
        else:
            first_delta["content"] = response_text
            if os.environ.get("TEST_PROVIDER_REASONING_SCENARIO") == "1":
                first_delta["reasoning_content"] = "Local fixture reasoning: inspect the supplied inputs."
        finish_reason = "tool_calls" if tool_call else "stop"
        chunks = [
            {
                "id": "chatcmpl-vibe-desktop-fixture",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "fixture-model",
                "choices": [
                    {"index": 0, "delta": first_delta, "finish_reason": None}
                ],
            },
            {
                "id": "chatcmpl-vibe-desktop-fixture",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "fixture-model",
                "choices": [
                    {"index": 0, "delta": {}, "finish_reason": finish_reason}
                ],
                "usage": {"prompt_tokens": 120, "completion_tokens": 12, "total_tokens": 132},
            },
        ]
        try:
            for chunk in chunks:
                self.wfile.write(f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n".encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    host, port = server.server_address
    print(json.dumps({"url": f"http://{host}:{port}/v1"}), flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
