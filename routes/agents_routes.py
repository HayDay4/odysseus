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
import re
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger(__name__)

# Path segments interpolated into the upstream URL (proposal name / run_id) must
# be simple identifiers — reject traversal / query-injection before proxying.
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]+$")


def _safe_segment(value: str) -> str | None:
    """Return a URL-encoded path segment, or None if it isn't a simple id."""
    if not value or not _SAFE_SEGMENT.match(value):
        return None
    return quote(value, safe="")

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


async def _post(path: str, body, timeout: float | None = None):
    """Proxy a POST to the panel, returning its JSON (or a 502 envelope).

    `timeout` overrides the default for slow synchronous endpoints (e.g. the
    Deep-review Opus call, which can run ~30-90s)."""
    try:
        async with httpx.AsyncClient(timeout=timeout or HTTP_TIMEOUT) as client:
            r = await client.post(f"{PANEL_BASE}{path}", json=body or {})
        return JSONResponse(r.json(), status_code=r.status_code)
    except httpx.HTTPError as e:
        logger.warning("aios proxy POST %s failed: %s", path, e)
        return JSONResponse({"error": f"panel unreachable: {e}"}, status_code=502)


async def _patch(path: str, body):
    """Proxy a PATCH to the panel, returning its JSON (or a 502 envelope).
    Used for issue lifecycle moves (PATCH /api/issues/{id})."""
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            r = await client.patch(f"{PANEL_BASE}{path}", json=body or {})
        return JSONResponse(r.json(), status_code=r.status_code)
    except httpx.HTTPError as e:
        logger.warning("aios proxy PATCH %s failed: %s", path, e)
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
        seg = _safe_segment(name)
        if seg is None:
            return JSONResponse({"error": "invalid proposal name"}, status_code=400)
        return await _get(f"/api/agents/proposals/{seg}")

    @router.post("/proposals/{name}/approve")
    async def proposal_approve(name: str):
        seg = _safe_segment(name)
        if seg is None:
            return JSONResponse({"error": "invalid proposal name"}, status_code=400)
        return await _post(f"/api/agents/proposals/{seg}/approve", {})

    @router.post("/proposals/{name}/reject")
    async def proposal_reject(name: str):
        seg = _safe_segment(name)
        if seg is None:
            return JSONResponse({"error": "invalid proposal name"}, status_code=400)
        return await _post(f"/api/agents/proposals/{seg}/reject", {})

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

    # Declared BEFORE /runs/{run_id} so the literal path wins (else run_id="history").
    @router.get("/runs/history")
    async def runs_history(request: Request):
        q = request.url.query
        return await _get(f"/api/runs/history{'?' + q if q else ''}")

    @router.get("/runs/{run_id}")
    async def run_get(run_id: str):
        seg = _safe_segment(run_id)
        if seg is None:
            return JSONResponse({"error": "invalid run_id"}, status_code=400)
        return await _get(f"/api/runs/{seg}")

    # --- Run terminal SSE passthrough (Phase 5 / P5-T4) ---
    @router.get("/runs/{run_id}/stream")
    async def run_stream(run_id: str):
        """Stream the panel's tool-calls.jsonl SSE through our origin so the
        EventSource in runTerminal.js stays same-origin. Forwards the upstream
        text/event-stream chunk-by-chunk."""
        seg = _safe_segment(run_id)
        if seg is None:
            return JSONResponse({"error": "invalid run_id"}, status_code=400)

        async def _relay():
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream("GET", f"{PANEL_BASE}/api/runs/{seg}/stream") as r:
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

    # --- Cockpit Workshop: projects, profiles, launch draft, run detail (Phase A) ---
    @router.get("/projects")
    async def projects():
        return await _get("/api/projects")

    @router.get("/profiles")
    async def profiles():
        return await _get("/api/profiles")

    @router.get("/projects/{slug}/active-runs")
    async def project_active_runs(slug: str):
        seg = _safe_segment(slug)
        if seg is None:
            return JSONResponse({"error": "invalid project slug"}, status_code=400)
        return await _get(f"/api/projects/{seg}/active-runs")

    @router.get("/projects/{slug}/kanban")
    async def project_kanban(slug: str):
        seg = _safe_segment(slug)
        if seg is None:
            return JSONResponse({"error": "invalid project slug"}, status_code=400)
        return await _get(f"/api/projects/{seg}/kanban")

    @router.get("/projects/{slug}/manager")
    async def project_manager(slug: str):
        seg = _safe_segment(slug)
        if seg is None:
            return JSONResponse({"error": "invalid project slug"}, status_code=400)
        return await _get(f"/api/projects/{seg}/manager")

    @router.post("/brief/draft")
    async def brief_draft(body: dict):
        return await _post("/api/brief/draft", body)

    @router.get("/runs/{run_id}/output")
    async def run_output(run_id: str):
        seg = _safe_segment(run_id)
        if seg is None:
            return JSONResponse({"error": "invalid run_id"}, status_code=400)
        return await _get(f"/api/runs/{seg}/output")

    @router.get("/runs/{run_id}/artifacts")
    async def run_artifacts(run_id: str):
        seg = _safe_segment(run_id)
        if seg is None:
            return JSONResponse({"error": "invalid run_id"}, status_code=400)
        return await _get(f"/api/runs/{seg}/artifacts")

    @router.get("/runs/{run_id}/diff")
    async def run_diff(run_id: str):
        seg = _safe_segment(run_id)
        if seg is None:
            return JSONResponse({"error": "invalid run_id"}, status_code=400)
        return await _get(f"/api/runs/{seg}/diff")

    @router.post("/runs/{run_id}/backfill-pr")
    async def run_backfill_pr(run_id: str):
        seg = _safe_segment(run_id)
        if seg is None:
            return JSONResponse({"error": "invalid run_id"}, status_code=400)
        return await _post(f"/api/runs/{seg}/backfill-pr", {})

    @router.post("/runs/{run_id}/cancel")
    async def run_cancel(run_id: str):
        seg = _safe_segment(run_id)
        if seg is None:
            return JSONResponse({"error": "invalid run_id"}, status_code=400)
        return await _post(f"/api/runs/{seg}/cancel", {})

    # --- Board: issues kanban / questions / deep-review (Phase B) ---
    # Only known query keys are forwarded (no blind passthrough) so the proxy
    # stays a tight allow-list surface even for the issues list.
    _ISSUE_QUERY_KEYS = ("status", "assignee", "created_by", "goal_id", "board")

    @router.get("/issues")
    async def issues(request: Request):
        parts = [
            f"{k}={quote(str(v), safe='')}"
            for k in _ISSUE_QUERY_KEYS
            if (v := request.query_params.get(k)) is not None
        ]
        qs = "?" + "&".join(parts) if parts else ""
        return await _get(f"/api/issues{qs}")

    @router.get("/issues/{issue_id}")
    async def issue_detail(issue_id: str):
        seg = _safe_segment(issue_id)
        if seg is None:
            return JSONResponse({"error": "invalid issue id"}, status_code=400)
        return await _get(f"/api/issues/{seg}")

    @router.post("/issues")
    async def issue_create(body: dict):
        return await _post("/api/issues", body)

    @router.patch("/issues/{issue_id}")
    async def issue_update(issue_id: str, body: dict):
        seg = _safe_segment(issue_id)
        if seg is None:
            return JSONResponse({"error": "invalid issue id"}, status_code=400)
        return await _patch(f"/api/issues/{seg}", body)

    @router.post("/issues/{issue_id}/merge")
    async def issue_merge(issue_id: str):
        seg = _safe_segment(issue_id)
        if seg is None:
            return JSONResponse({"error": "invalid issue id"}, status_code=400)
        return await _post(f"/api/issues/{seg}/merge", {})

    @router.get("/questions")
    async def questions():
        return await _get("/api/questions")

    @router.post("/questions/{q_id}/answer")
    async def question_answer(q_id: str, body: dict):
        seg = _safe_segment(q_id)
        if seg is None:
            return JSONResponse({"error": "invalid question id"}, status_code=400)
        return await _post(f"/api/questions/{seg}/answer", body)

    @router.post("/review/deep")
    async def review_deep(body: dict):
        # Opus reads the item's full context + reasons — allow a long synchronous
        # window (the panel caps the model call itself; we just wait on it).
        return await _post("/api/review/deep", body, timeout=150.0)

    return router
