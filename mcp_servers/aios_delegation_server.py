"""
aios_delegation_server.py

MCP server that lets the Overlord (local model) delegate WORK-domain tasks to the
AIOS Claude workforce, reached only through the egress gate → the panel control-
plane API on :17776. This is the bridge in ``odysseus_eval/MIGRATION_PLAN.md`` §2.

Roadblock it works around: an external MCP tool call BLOCKS the agent loop (no
streaming), so delegation is **fire-and-poll** — ``aios_spawn_run`` returns a
``run_id`` instantly, then ``aios_run_status`` / ``aios_run_tail`` poll. The
panel API is the permanent headless workforce backend; these tools are thin
server-side proxies over it (httpx, short-lived client, explicit timeout).

Registered in ``src/builtin_mcp.py`` (_BUILTIN_SERVERS) so it auto-launches, but
deliberately OMITTED from ``MCPManager.is_builtin()`` so it is exposed in the
OpenAI function-calling schemas (``get_all_openai_schemas`` skips is_builtin
Python servers) and the agent calls it natively. Trade-off: it forfeits the
builtin auto-reconnect on subprocess death — acceptable for a stateless proxy.

Copy-reference template: ``mcp_servers/memory_server.py`` (raw mcp SDK, stdio).
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

server = Server("aios_delegation")

# Panel control-plane API (the headless workforce backend). Override via env for
# tests / non-default binds. Default per MIGRATION_TASKS "Defaults adopted".
PANEL_BASE = os.environ.get("AIOS_PANEL_URL", "http://127.0.0.1:17776").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("AIOS_PANEL_TIMEOUT", "15"))

# Run-dir roots for the structured audit trail (bwrap-safe; B7). Mirrors the
# panel's config.run_roots(). ns is parsed from the run_id prefix.
_RUN_ROOTS = {"core": Path("/tmp/core"), "brief": Path("/tmp/brief")}


def _ns_of(run_id: str) -> str:
    """Namespace is the run_id prefix before the first hyphen (brief-… / core-…)."""
    return (run_id.split("-", 1)[0] or "brief").strip()


def _err(msg: str) -> list[TextContent]:
    return [TextContent(type="text", text=f"Error: {msg}")]


def _json_text(obj) -> list[TextContent]:
    return [TextContent(type="text", text=json.dumps(obj, indent=2, default=str))]


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="aios_spawn_run",
            description=(
                "Delegate a WORK-domain task to the AIOS Claude workforce. Returns a "
                "run_id instantly (fire-and-poll — does NOT wait for completion; poll "
                "with aios_run_status). Only send non-sensitive, already-scrubbed "
                "prompts — this egresses to Claude."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "description": "Project slug (registry key) to run in."},
                    "prompt": {"type": "string", "description": "The task text for the Claude agent."},
                    "profile": {"type": "string", "description": "Optional agent profile (e.g. web-developer, market-trader)."},
                },
                "required": ["slug", "prompt"],
            },
        ),
        Tool(
            name="aios_run_status",
            description="Get the current status/metadata of a delegated run by run_id.",
            inputSchema={
                "type": "object",
                "properties": {"run_id": {"type": "string", "description": "The run_id from aios_spawn_run."}},
                "required": ["run_id"],
            },
        ),
        Tool(
            name="aios_run_list",
            description="List active and recent workforce runs (id, status, task, cost).",
            inputSchema={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["active", "recent", "both"],
                              "description": "Which runs to list (default both)."}
                },
            },
        ),
        Tool(
            name="aios_run_tail",
            description="Tail the structured tool-call audit trail (tool-calls.jsonl) of a run.",
            inputSchema={
                "type": "object",
                "properties": {
                    "run_id": {"type": "string", "description": "The run_id to tail."},
                    "lines": {"type": "integer", "description": "How many trailing lines (default 20, max 200)."},
                },
                "required": ["run_id"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "aios_spawn_run":
            return await _spawn_run(arguments)
        if name == "aios_run_status":
            return await _run_status(arguments)
        if name == "aios_run_list":
            return await _run_list(arguments)
        if name == "aios_run_tail":
            return await _run_tail(arguments)
        return _err(f"Unknown tool: {name}")
    except httpx.HTTPError as e:
        return _err(f"panel API unreachable ({PANEL_BASE}): {type(e).__name__}: {e}")
    except Exception as e:  # never crash the agent loop
        return _err(f"{type(e).__name__}: {e}")


async def _spawn_run(arguments: dict) -> list[TextContent]:
    slug = (arguments.get("slug") or "").strip()
    prompt = (arguments.get("prompt") or "").strip()
    profile = (arguments.get("profile") or "").strip() or None
    if not slug or not prompt:
        return _err("aios_spawn_run needs both slug and prompt")
    payload = {"slug": slug, "prompt": prompt}
    if profile:
        payload["profile"] = profile
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.post(f"{PANEL_BASE}/api/brief/spawn", json=payload)
    if resp.status_code not in (200, 201):
        return _err(f"spawn failed (HTTP {resp.status_code}): {resp.text[:300]}")
    data = resp.json()
    if not data.get("ok"):
        return _err(f"spawn rejected: {data.get('error') or data}")
    return [TextContent(type="text", text=(
        f"Delegated. run_id={data.get('run_id')} (ns={data.get('ns')}, "
        f"profile={data.get('profile')}). Poll with aios_run_status."
    ))]


async def _run_status(arguments: dict) -> list[TextContent]:
    run_id = (arguments.get("run_id") or "").strip()
    if not run_id:
        return _err("aios_run_status needs run_id")
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(f"{PANEL_BASE}/api/runs/{run_id}")
    if resp.status_code == 404:
        return _err(f"run {run_id} not found")
    if resp.status_code != 200:
        return _err(f"status failed (HTTP {resp.status_code}): {resp.text[:300]}")
    return _json_text(resp.json())


async def _run_list(arguments: dict) -> list[TextContent]:
    scope = (arguments.get("scope") or "both").strip()
    out = {}
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        if scope in ("active", "both"):
            r = await client.get(f"{PANEL_BASE}/api/runs/active")
            out["active"] = r.json().get("runs", []) if r.status_code == 200 else []
        if scope in ("recent", "both"):
            r = await client.get(f"{PANEL_BASE}/api/runs/recent")
            out["recent"] = r.json().get("runs", []) if r.status_code == 200 else []
    return _json_text(out)


async def _run_tail(arguments: dict) -> list[TextContent]:
    run_id = (arguments.get("run_id") or "").strip()
    if not run_id:
        return _err("aios_run_tail needs run_id")
    lines = arguments.get("lines") or 20
    try:
        lines = max(1, min(int(lines), 200))
    except (TypeError, ValueError):
        lines = 20
    ns = _ns_of(run_id)
    root = _RUN_ROOTS.get(ns, Path("/tmp") / ns)
    tc = root / run_id / "tool-calls.jsonl"
    if not tc.is_file():
        return [TextContent(type="text", text=f"No tool-calls.jsonl yet for {run_id} (at {tc}).")]
    try:
        tail = tc.read_text(errors="replace").splitlines()[-lines:]
    except OSError as e:
        return _err(f"could not read {tc}: {e}")
    return [TextContent(type="text", text="\n".join(tail) if tail else "(empty)")]


async def run():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(run())
