"""Tests for grillme.parse_handoff / compose_brief_text.

These fixtures simulate the messy output a *weak local model* produces — the real
"works with any local model in Odysseus" guarantee lives here, deterministic and
model-free. Every malformed shape must parse to a valid defaulted brief, and an
unrecoverable input must degrade to None (never raise).
"""
import json

import pytest

from src.grillme import (
    DEFAULT_MODE,
    DEFAULT_PROFILE,
    compose_brief_text,
    normalize_handoff,
    parse_handoff,
)

CLEAN = {
    "title": "Add a contact form",
    "project_slug": "polish-cafe-landing",
    "goal": "Add a contact form to the landing page with no backend.",
    "context": "Static Next.js marketing site.",
    "acceptance_criteria": ["Form renders", "Client-side validation"],
    "constraints": ["No backend", "Keep existing styling"],
    "out_of_scope": ["Email delivery"],
    "suggested_profile": "web-builder",
    "suggested_mode": "think",
    "suggested_decomposition": [
        {
            "title": "Build the form component",
            "profile": "web-builder",
            "prompt": "Create a ContactForm React component...",
            "mode": "quick",
        }
    ],
    "notes_for_workforce": "Match the existing Tailwind tokens.",
}


def _fenced(obj):
    return "Sure, here is your handoff:\n\n```json\n" + json.dumps(obj, indent=2) + "\n```\nLet me know!"


def test_clean_fenced():
    out = parse_handoff(_fenced(CLEAN))
    assert out is not None
    assert out["title"] == "Add a contact form"
    assert out["project_slug"] == "polish-cafe-landing"
    assert out["suggested_profile"] == "web-builder"
    assert out["suggested_mode"] == "think"
    assert out["acceptance_criteria"] == ["Form renders", "Client-side validation"]
    assert out["suggested_decomposition"][0]["mode"] == "quick"


def test_bare_no_fence():
    out = parse_handoff(json.dumps(CLEAN))
    assert out is not None and out["goal"].startswith("Add a contact form")


def test_prose_wrapped_unfenced():
    text = (
        "I think I have enough now. PRODUCE HANDOFF:\n"
        + json.dumps(CLEAN)
        + "\n\nThat should be everything you need."
    )
    out = parse_handoff(text)
    assert out is not None and out["title"] == "Add a contact form"


def test_trailing_commas():
    blob = """```json
{
  "title": "Trailing comma brief",
  "goal": "Do the thing",
  "acceptance_criteria": ["a", "b",],
  "constraints": [],
}
```"""
    out = parse_handoff(blob)
    assert out is not None
    assert out["title"] == "Trailing comma brief"
    assert out["acceptance_criteria"] == ["a", "b"]


def test_line_comments():
    blob = """{
  "title": "Commented brief",  // the model added a comment
  "goal": "ship it",
  "suggested_profile": "shell-tooling"
}"""
    out = parse_handoff(blob)
    assert out is not None and out["suggested_profile"] == "shell-tooling"


def test_url_not_eaten_by_comment_strip():
    blob = """{
  "title": "Has a url",
  "goal": "see https://example.com/docs for details",
  "acceptance_criteria": ["works",]
}"""
    out = parse_handoff(blob)
    assert out is not None
    assert "https://example.com/docs" in out["goal"]


def test_apostrophe_in_value():
    blob = '{"title": "diego\'s brief", "goal": "do diego\'s thing"}'
    out = parse_handoff(blob)
    assert out is not None and out["title"] == "diego's brief"


def test_picks_largest_object_over_stray():
    text = 'noise {"x": 1} more noise ' + json.dumps(CLEAN)
    out = parse_handoff(text)
    assert out is not None and out["title"] == "Add a contact form"


def test_invalid_profile_and_mode_default():
    out = parse_handoff(json.dumps({"title": "t", "goal": "g", "suggested_profile": "wizard", "suggested_mode": "turbo"}))
    assert out is not None
    assert out["suggested_profile"] == DEFAULT_PROFILE
    assert out["suggested_mode"] == DEFAULT_MODE


def test_minimal_brief_still_parses():
    out = parse_handoff('{"goal": "just do it"}')
    assert out is not None
    assert out["goal"] == "just do it"
    assert out["suggested_mode"] == DEFAULT_MODE
    assert out["suggested_decomposition"] == []


def test_decomposition_item_inherits_defaults():
    obj = {
        "title": "t",
        "goal": "g",
        "suggested_profile": "software-engineer",
        "suggested_mode": "ensemble",
        "suggested_decomposition": [{"title": "sub", "prompt": "do x"}],
    }
    out = parse_handoff(json.dumps(obj))
    item = out["suggested_decomposition"][0]
    assert item["profile"] == "software-engineer"  # inherited
    assert item["mode"] == "ensemble"  # inherited


def test_unrecoverable_returns_none():
    assert parse_handoff("no json here at all, just chatter") is None
    assert parse_handoff("") is None
    assert parse_handoff("   ") is None
    assert parse_handoff("{ this is : not json and : unrecoverable ][ }") is None


def test_string_coercion_of_wrong_types():
    obj = {"title": 123, "goal": "g", "acceptance_criteria": "single string crit"}
    out = parse_handoff(json.dumps(obj))
    assert out["title"] == "123"
    assert out["acceptance_criteria"] == ["single string crit"]


def test_compose_brief_text_self_contained():
    brief = normalize_handoff(CLEAN)
    text = compose_brief_text(brief)
    assert "# Add a contact form" in text
    assert "polish-cafe-landing" in text
    assert "## Goal" in text
    assert "## Acceptance criteria" in text
    assert "- Form renders" in text
    assert "## Suggested decomposition" in text
    assert "Build the form component" in text
    assert "## Notes for workforce" in text


def test_compose_handles_empty_brief():
    text = compose_brief_text({})
    assert "untitled" in text.lower()
    # no crash, ends with newline
    assert text.endswith("\n")


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
