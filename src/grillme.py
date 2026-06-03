"""grillme — local-model intake → handoff brief parsing (GRILLME_PROMPT.md).

The `/grill-me` front door runs a *local* model (qwen today, but any Ollama model
diego registers) as a conversational interrogator. When diego says PRODUCE HANDOFF,
the model emits a structured brief as a JSON object. Small/weak local models do NOT
reliably emit clean JSON (fences, trailing commas, prose wrappers, // comments,
truncation), and many have no tool/function-calling — so we parse from plain text,
tolerantly, and NEVER hard-fail: an unrecoverable brief degrades to "diego edits the
raw text at the egress gate", not a crash.

Pure logic only (stdlib). `parse_handoff(text)` and `compose_brief_text(brief)` are
unit-tested in tests/test_grillme.py against malformed-output fixtures — that test is
the real "works with any local model" guarantee.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

# The cockpit's spawn modes (workshop.js:23-27) — the local model recommends one
# per task; diego confirms/overrides in the cockpit. Default is the cheapest.
VALID_MODES = ("quick", "think", "ensemble")
DEFAULT_MODE = "quick"

# Subagent profiles the workforce knows (GRILLME_PROMPT §3). Unknown → _default.
VALID_PROFILES = (
    "web-builder",
    "software-engineer",
    "shell-tooling",
    "market-trader",
    "_default",
)
DEFAULT_PROFILE = "_default"

# Fields of the normalized brief, with their empty defaults.
_LIST_FIELDS = ("acceptance_criteria", "constraints", "out_of_scope")
_STR_FIELDS = ("title", "project_slug", "goal", "context", "notes_for_workforce")


# ── extraction ──────────────────────────────────────────────────────────────
def _balanced_object_spans(text: str) -> List[str]:
    """Return every top-level balanced ``{...}`` substring, in document order.

    String-aware (tracks JSON double-quoted strings + escapes) so braces inside
    string values don't throw off the depth count, and apostrophes in prose
    ("diego's") never start a string. Single-quoted JSON is handled later by the
    lenient loader, not here — keeping the matcher to ``"`` avoids misreading
    apostrophes as delimiters.
    """
    spans: List[str] = []
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, c in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start != -1:
                    spans.append(text[start : i + 1])
                    start = -1
    return spans


def _lenient_loads(blob: str) -> Optional[Any]:
    """json.loads, then a conservative repair pass for weak-model output."""
    try:
        return json.loads(blob)
    except Exception:
        pass
    repaired = blob
    # Strip /* block */ comments and // line comments. The (?<!:) guard keeps us
    # from eating the // in an "http://..." value at end-of-line.
    repaired = re.sub(r"/\*.*?\*/", "", repaired, flags=re.S)
    repaired = re.sub(r"(?m)(?<!:)//[^\n]*$", "", repaired)
    # Drop trailing commas before a closing } or ].
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    try:
        return json.loads(repaired)
    except Exception:
        return None


def parse_handoff(text: str) -> Optional[Dict[str, Any]]:
    """Extract + normalize a handoff brief from arbitrary local-model text.

    Strategy (tolerant, any-model): prefer a fenced ```json block, else scan for
    balanced ``{...}`` objects and take the *largest* that parses into a dict with
    at least one recognizable brief field. Returns a normalized dict, or ``None``
    if nothing usable is found (caller then shows raw text for manual editing).
    """
    if not text or not str(text).strip():
        return None
    raw = str(text)

    candidates: List[str] = []
    # 1. Fenced blocks first — the contract tells the model to fence its JSON.
    for m in re.finditer(r"```(?:json|JSON)?\s*(.+?)```", raw, flags=re.S):
        candidates.append(m.group(1))
    # 2. Every balanced object anywhere in the text (covers unfenced output).
    candidates.extend(_balanced_object_spans(raw))

    # Largest first — the brief is the biggest object; a stray {"a":1} loses.
    parsed: List[Dict[str, Any]] = []
    for blob in sorted(set(candidates), key=len, reverse=True):
        obj = _lenient_loads(blob)
        if isinstance(obj, dict) and _looks_like_brief(obj):
            parsed.append(obj)
    # Also try the largest balanced span even if it didn't "look like" a brief,
    # so a minimal {goal:...} still produces something to review.
    if not parsed:
        for blob in sorted(set(candidates), key=len, reverse=True):
            obj = _lenient_loads(blob)
            if isinstance(obj, dict) and obj:
                parsed.append(obj)
                break
    if not parsed:
        return None
    return normalize_handoff(parsed[0])


def _looks_like_brief(obj: Dict[str, Any]) -> bool:
    keys = set(obj.keys())
    signal = {
        "title",
        "goal",
        "project_slug",
        "acceptance_criteria",
        "suggested_profile",
        "suggested_decomposition",
        "notes_for_workforce",
    }
    return len(keys & signal) >= 2


# ── normalization ───────────────────────────────────────────────────────────
def _as_str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ("" if v is None else str(v))


def _as_str_list(v: Any) -> List[str]:
    if isinstance(v, str):
        return [v.strip()] if v.strip() else []
    if isinstance(v, list):
        return [_as_str(x) for x in v if _as_str(x)]
    return []


def _norm_mode(v: Any, default: str = DEFAULT_MODE) -> str:
    s = _as_str(v).lower()
    return s if s in VALID_MODES else default


def _norm_profile(v: Any, default: str = DEFAULT_PROFILE) -> str:
    s = _as_str(v)
    return s if s in VALID_PROFILES else default


def normalize_handoff(obj: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce a parsed brief into the canonical shape with safe defaults.

    Never raises on a missing/mis-typed field — fills the default instead, so a
    partial brief from a weak model still flows to the egress gate for review.
    """
    out: Dict[str, Any] = {}
    for k in _STR_FIELDS:
        out[k] = _as_str(obj.get(k))
    for k in _LIST_FIELDS:
        out[k] = _as_str_list(obj.get(k))
    out["suggested_profile"] = _norm_profile(obj.get("suggested_profile"))
    out["suggested_mode"] = _norm_mode(obj.get("suggested_mode") or obj.get("mode"))

    items_in = obj.get("suggested_decomposition")
    items: List[Dict[str, Any]] = []
    if isinstance(items_in, list):
        for it in items_in:
            if not isinstance(it, dict):
                continue
            items.append(
                {
                    "title": _as_str(it.get("title")),
                    "profile": _norm_profile(
                        it.get("profile"), default=out["suggested_profile"]
                    ),
                    "prompt": _as_str(it.get("prompt")),
                    "mode": _norm_mode(it.get("mode"), default=out["suggested_mode"]),
                }
            )
    out["suggested_decomposition"] = items
    return out


# ── canonical text (the egress preview + spawn prompt base) ─────────────────
def compose_brief_text(brief: Dict[str, Any]) -> str:
    """Render a normalized brief as the human-readable document that egresses.

    This text is what `gate()` scrubs and what diego sees in the Approve-egress
    modal; the scrubbed version is also the prompt handed to the workforce. Self
    contained enough for a Claude specialist with no prior context (GRILLME §3).
    """
    b = brief if isinstance(brief, dict) else {}
    title = b.get("title") or "(untitled brief)"
    lines: List[str] = [f"# {title}"]
    meta = (
        f"Project: {b.get('project_slug') or '(unset)'}"
        f" · Profile: {b.get('suggested_profile') or DEFAULT_PROFILE}"
        f" · Mode: {b.get('suggested_mode') or DEFAULT_MODE}"
    )
    lines.append(meta)

    def _section(heading: str, body: str) -> None:
        if body and body.strip():
            lines.extend(["", f"## {heading}", body.strip()])

    def _bullets(heading: str, items: List[str]) -> None:
        if items:
            lines.extend(["", f"## {heading}"])
            lines.extend(f"- {x}" for x in items)

    _section("Goal", b.get("goal", ""))
    _section("Context", b.get("context", ""))
    _bullets("Acceptance criteria", b.get("acceptance_criteria", []))
    _bullets("Constraints", b.get("constraints", []))
    _bullets("Out of scope", b.get("out_of_scope", []))

    items = b.get("suggested_decomposition") or []
    if items:
        lines.extend(["", "## Suggested decomposition"])
        for i, it in enumerate(items, 1):
            head = f"{i}. [{it.get('profile', DEFAULT_PROFILE)} · {it.get('mode', DEFAULT_MODE)}] {it.get('title', '')}".rstrip()
            lines.append(head)
            if it.get("prompt"):
                lines.append(f"   {it['prompt'].strip()}")

    _section("Notes for workforce", b.get("notes_for_workforce", ""))
    return "\n".join(lines).strip() + "\n"
