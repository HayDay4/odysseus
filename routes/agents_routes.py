# routes/agents_routes.py
# Same-origin proxy to the AIOS panel control-plane API (:17776), so the native
# Odysseus "glance views" (roster, org, proposals, brief, inbox, runs) and the
# ops console (kanban, run terminal) fetch through our own origin instead of
# cross-origin to the panel. MIGRATION_PLAN §7.
#
# The panel API is the permanent headless workforce backend; this file is a thin
# forwarder (httpx, short-lived client, explicit timeout, graceful errors). It
# adds NO logic — every view's data shape is whatever the panel returns.
#
# Overlord-side paths are namespaced /api/aios/* → panel /api/{agents,org,brief,
# inbox,runs}/*. The SSE passthrough (/api/aios/runs/{id}/stream) is added in
# Phase 5 (P5-T4) for the run terminal.
import logging

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger(__name__)

# Panel control-plane API. Overridable for non-default binds / tests.
import os
PANEL_BASE = os.environ.get("AIOS_PANEL_URL", "http://127.0.0.1:17776").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("AIOS_PANEL_TIMEOUT", "15"))


async def _get(path: str):
    """Proxy a GET to the panel, returning its JSON (or a 502 envelope)."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            r = await client.get(f"{PANEL_BASE}{path}")
        return JSONResponse(r.json(), status_code=r.status_code)
    except httpx.HTTPError as e:
        logger.warning("aios proxy GET %s failed: %s", path, e)
        return JSONResponse({"error": f"panel unreachable: {e}"}, status_code=502)


async def _post(path: str, body):
    """Proxy a POST to the panel, returning its JSON (or a 502 envelope)."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            r = await client.post(f"{PANEL_BASE}{path}", json=body or {})
        return JSONResponse(r.json(), status_code=r.status_code)
    except httpx.HTTPError as e:
        logger.warning("aios proxy POST %s failed: %s", path, e)
        return JSONResponse({"error": f"panel unreachable: {e}"}, status_code=502)


def setup_agents_routes() -> APIRouter:
    router = APIRouter(prefix="/api/aios", tags=["aios"])

    # --- Glance views (Phase 4) ---
    @router.get("/roster")
    async def roster():
        return await _get("/api/agents/roster")

    @router.get("/org")
    async def org():
        return await _get("/api/org")

    @router.get("/proposals")
    async def proposals():
        return await _get("/api/agents/proposals")

    @router.get("/proposals/{name}")
    async def proposal_detail(name: str):
        return await _get(f"/api/agents/proposals/{name}")

    @router.post("/proposals/{name}/approve")
    async def proposal_approve(name: str):
        return await _post(f"/api/agents/proposals/{name}/approve", {})

    @router.post("/proposals/{name}/reject")
    async def proposal_reject(name: str):
        return await _post(f"/api/agents/proposals/{name}/reject", {})

    @router.post("/brief/spawn")
    async def brief_spawn(body: dict):
        return await _post("/api/brief/spawn", body)

    @router.get("/inbox")
    async def inbox():
        return await _get("/api/inbox")

    # --- Runs (Phase 5 kanban) ---
    @router.get("/runs/active")
    async def runs_active():
        return await _get("/api/runs/active")

    @router.get("/runs/recent")
    async def runs_recent():
        return await _get("/api/runs/recent")

    @router.get("/runs/{run_id}")
    async def run_get(run_id: str):
        return await _get(f"/api/runs/{run_id}")

    # --- Run terminal SSE passthrough (Phase 5 / P5-T4) ---
    @router.get("/runs/{run_id}/stream")
    async def run_stream(run_id: str):
        """Stream the panel's tool-calls.jsonl SSE through our origin so the
        EventSource in runTerminal.js stays same-origin. Forwards the upstream
        text/event-stream chunk-by-chunk."""
        async def _relay():
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("GET", f"{PANEL_BASE}/api/runs/{run_id}/stream") as r:
                        async for chunk in r.aiter_bytes():
                            yield chunk
            except httpx.HTTPError as e:
                logger.warning("aios SSE proxy %s failed: %s", run_id, e)
                yield f"data: {{\"error\": \"panel stream unreachable\"}}\n\n".encode()
        return StreamingResponse(
            _relay(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return router
