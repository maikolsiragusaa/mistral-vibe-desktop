"""Disposable stdio MCP fixture; never connects to an external service."""
from mcp.server.fastmcp import FastMCP
import json
import socket
import sys

if "--http" in sys.argv:
    with socket.socket() as candidate:
        candidate.bind(("127.0.0.1", 0))
        port = candidate.getsockname()[1]
    server = FastMCP("Desktop fixture", host="127.0.0.1", port=port, stateless_http=True, json_response=True)
else:
    server = FastMCP("Desktop fixture")

@server.tool()
def fixture_ping() -> str:
    """Return a local fixture acknowledgement."""
    return "Local MCP fixture ready."

if __name__ == "__main__":
    if "--http" in sys.argv:
        print(json.dumps({"url": f"http://127.0.0.1:{port}/mcp"}), flush=True)
        server.run(transport="streamable-http")
    else:
        server.run(transport="stdio")
