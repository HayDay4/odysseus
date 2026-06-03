"""HTTP integration test for the /grill-me handoff → egress handshake.

Mounts ONLY the grillme + egress routers (no full-app startup) with the egress
temp-file paths redirected to a tmp dir, so the whole staging→decision chain is
exercised over real HTTP with zero risk to the live data dir and no spawns.
"""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    egress_routes = importlib.import_module("routes.egress_routes")
    monkeypatch.setattr(egress_routes, "_PENDING_PATH", str(tmp_path / "egress_pending.json"))
    monkeypatch.setattr(egress_routes, "_DECISION_PATH", str(tmp_path / "egress_decision.json"))
    grillme_routes = importlib.import_module("routes.grillme_routes")

    app = FastAPI()
    app.include_router(egress_routes.setup_egress_routes())
    app.include_router(grillme_routes.setup_grillme_routes())
    return TestClient(app)


HANDOFF_TEXT = """Alright, I have enough. PRODUCE HANDOFF:

```json
{
  "title": "Add a contact form",
  "project_slug": "polish-cafe-landing",
  "goal": "Add a contact form to the landing page, no backend.",
  "acceptance_criteria": ["form renders", "client-side validation"],
  "constraints": ["no backend"],
  "suggested_profile": "web-builder",
  "suggested_mode": "think",
  "notes_for_workforce": "ssh key lives at ~/.ssh/id_rsa — ignore it"
}
```
"""


def test_handoff_stages_scrubbed_brief_then_decision(client):
    # 1. Stage the handoff.
    r = client.post("/api/grillme/handoff", json={"text": HANDOFF_TEXT})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    rid = body["request_id"]
    assert rid.startswith("grill-")
    assert body["parsed"]["project_slug"] == "polish-cafe-landing"
    assert body["parsed"]["suggested_profile"] == "web-builder"
    assert body["parsed"]["suggested_mode"] == "think"
    # The credential path must be redacted in the egress preview.
    assert "id_rsa" not in body["scrubbed"]
    assert "credential-path" in body["secrets"]

    # 2. The pending preview is visible to the modal.
    p = client.get("/api/egress/pending").json()
    assert p["pending"]["request_id"] == rid
    assert "id_rsa" not in p["pending"]["scrubbed"]

    # 3. No decision yet for our id.
    d0 = client.get("/api/egress/decision", params={"request_id": rid}).json()
    assert d0["matches"] is False

    # 4. Approve → decision recorded + pending cleared.
    c = client.post("/api/egress/consent", json={"request_id": rid, "approve": True})
    assert c.status_code == 200 and c.json()["ok"] is True
    d1 = client.get("/api/egress/decision", params={"request_id": rid}).json()
    assert d1["matches"] is True and d1["decision"]["approved"] is True
    assert client.get("/api/egress/pending").json()["pending"] is None


def test_handoff_rejects_unparseable(client):
    r = client.post("/api/grillme/handoff", json={"text": "just chit-chat, no brief"})
    assert r.status_code == 422
    assert r.json()["error"] == "no_handoff"


def test_decision_does_not_match_other_request(client):
    client.post("/api/grillme/handoff", json={"text": HANDOFF_TEXT})
    # A decision recorded for a different id must not be claimed by ours.
    client.post("/api/egress/consent", json={"request_id": "someone-else", "approve": True})
    d = client.get("/api/egress/decision", params={"request_id": "grill-doesnotexist"}).json()
    assert d["matches"] is False


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
