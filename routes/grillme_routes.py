# routes/grillme_routes.py
# The /grill-me handoff endpoint (GRILLME_PROMPT.md phase 3). The local model
# interrogates diego in a normal chat, then emits a JSON handoff brief. This route
# turns that raw model text into a reviewed, scrubbed brief staged at the egress
# gate — the privacy-wall checkpoint. Nothing here egresses to the workforce; it
# only stages the scrubbed preview for diego's Approve-egress decision. The
# frontend then polls GET /api/egress/decision and, on approve, pre-fills the
# cockpit spawn box with the scrubbed brief.
#
# We ALWAYS stage to the gate, even when gate() says allow=True (a benign brief is
# not "sensitive"), because the front door must show diego EVERY brief before it
# leaves the local zone — that's the whole point of the wall.
import logging
import uuid

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from src.egress_gate import gate
from src.grillme import compose_brief_text, parse_handoff
from routes.egress_routes import enqueue_pending

logger = logging.getLogger(__name__)


def setup_grillme_routes() -> APIRouter:
    router = APIRouter(prefix="/api/grillme", tags=["grillme"])

    @router.post("/handoff")
    async def grillme_handoff(body: dict):
        """Parse a handoff brief from local-model text, scrub it, and stage it at
        the egress gate for review.

        Body: {"text": "<assistant message containing the handoff JSON>"}.
        Returns {ok, request_id, scrubbed, parsed} on success; on unparseable
        input, {ok: false, error: "no_handoff"} so the UI can ask diego to retry
        or edit. `scrubbed` is the EXACT text that will egress (use it as the
        spawn prompt); `parsed` is metadata only (slug/profile/mode/decomposition).
        """
        text = (body or {}).get("text") or ""
        parsed = parse_handoff(text)
        if not parsed:
            return JSONResponse(
                {"ok": False, "error": "no_handoff",
                 "detail": "Could not find a handoff brief in the model output."},
                status_code=422,
            )

        brief_text = compose_brief_text(parsed)
        verdict = gate(brief_text, source="grillme")
        request_id = "grill-" + uuid.uuid4().hex[:12]
        reasons = list(verdict.get("reasons") or [])
        # Make it explicit in the modal that this is the front-door review, not a
        # sensitivity flag — the brief is shown for approval regardless.
        reasons.insert(0, "grill-me handoff — review before it reaches the workforce")

        enqueue_pending(
            request_id,
            scrubbed=verdict["scrubbed"],
            reasons=reasons,
            target="claude",
        )
        return JSONResponse(
            {
                "ok": True,
                "request_id": request_id,
                "scrubbed": verdict["scrubbed"],
                "secrets": verdict.get("secrets") or [],
                "parsed": parsed,
            }
        )

    return router
