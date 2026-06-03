# routes/egress_routes.py
# The "Approve egress" consent handshake (MIGRATION_PLAN §4, step 3). When the
# Overlord wants to egress sensitive content to a remote model, it must first
# show diego the EXACT scrubbed payload and get an explicit yes. The handshake is
# a temp-file pair under data/ (decided in OVERNIGHT_PROMPT §4):
#
#   data/egress_pending.json   — the gate writes the scrubbed preview here.
#   data/egress_decision.json  — this route writes diego's approve/reject here;
#                                the gate (caller) polls for it, keyed by request_id.
#
# Two routes back the egressConsent.js modal:
#   GET  /api/egress/pending   — current pending preview (or {"pending": null}).
#   POST /api/egress/consent   — {request_id, approve} → write the decision file.
#
# enqueue_pending() is the gate-side helper that stages a request; kept here so
# the file schema has a single owner. Stdlib + atomic writes only.
import json
import logging
import os
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from src.constants import DATA_DIR
from core.atomic_io import atomic_write_json

logger = logging.getLogger(__name__)

_PENDING_PATH = os.path.join(DATA_DIR, "egress_pending.json")
_DECISION_PATH = os.path.join(DATA_DIR, "egress_decision.json")


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def enqueue_pending(request_id: str, *, scrubbed: str, reasons=None, target: str = "claude") -> dict:
    """Stage an egress request for diego to approve. Called by the gate, not the UI.
    Returns the written record. Never raises on a bad write path (best-effort)."""
    record = {
        "request_id": request_id,
        "scrubbed": scrubbed,
        "reasons": reasons or [],
        "target": target,
        "created_at": int(time.time()),
    }
    try:
        atomic_write_json(_PENDING_PATH, record, indent=2)
    except OSError as e:
        logger.warning("egress: could not stage pending request %s: %s", request_id, e)
    return record


def read_decision():
    """Gate-side helper: read the latest decision (or None)."""
    return _read_json(_DECISION_PATH)


def setup_egress_routes() -> APIRouter:
    router = APIRouter(prefix="/api/egress", tags=["egress"])

    @router.get("/pending")
    async def egress_pending():
        rec = _read_json(_PENDING_PATH)
        return JSONResponse({"pending": rec})

    @router.get("/decision")
    async def egress_decision(request_id: str = ""):
        """Report the last recorded decision. A caller that staged a request polls
        this for its own `request_id` — the egressConsent.js modal records the
        decision but fires no callback, so the staging caller learns the outcome
        here. Returns {decision: <rec>|null, matches: bool}."""
        rec = _read_json(_DECISION_PATH)
        matches = bool(rec and request_id and rec.get("request_id") == request_id)
        return JSONResponse({"decision": rec, "matches": matches})

    @router.post("/consent")
    async def egress_consent(body: dict):
        request_id = (body or {}).get("request_id")
        approve = bool((body or {}).get("approve"))
        if not request_id:
            return JSONResponse({"ok": False, "error": "request_id required"}, status_code=400)
        decision = {
            "request_id": request_id,
            "approved": approve,
            "decided_at": int(time.time()),
        }
        try:
            atomic_write_json(_DECISION_PATH, decision, indent=2)
        except OSError as e:
            logger.warning("egress: could not write decision for %s: %s", request_id, e)
            return JSONResponse({"ok": False, "error": "write failed"}, status_code=500)
        # Clear the pending preview once a decision is recorded (best-effort).
        try:
            if os.path.exists(_PENDING_PATH):
                os.remove(_PENDING_PATH)
        except OSError:
            pass
        return JSONResponse({"ok": True, "decision": decision})

    return router
