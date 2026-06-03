"""Secret-scrubbing for settings exposed to non-admin / unauthenticated callers.

Deliberately dependency-light (stdlib only) and separate from
``routes/auth_routes.py`` so it can be imported and unit-tested without dragging
in the FastAPI app / auth / database import chain.

``/api/auth/settings`` is auth-exempt — the frontend (and the pre-login page)
read it for keybinds + TTS prefs, so non-admin and unauthenticated callers get a
*scrubbed* copy. Secrets (provider API keys, IMAP/SMTP passwords, OAuth tokens)
must NOT leak to them — load-bearing when the app is reachable over a Cloudflare
tunnel / reverse proxy. Scrubbing is deep (recurses nested dicts/lists) and keyed
on secret-shaped names.
"""

_SECRET_KEY_PATTERNS = (
    "_api_key", "_apikey", "_password", "_passwd", "_pass", "_pwd",
    "_secret", "_client_secret", "_token", "_access_token", "_refresh_token",
    "_credential", "_credentials", "_key",
)
_SECRET_KEY_ALLOW = ("google_pse_cx",)  # public identifiers, not secrets


def is_secret_key(name: str) -> bool:
    n = (name or "").lower()
    if n in _SECRET_KEY_ALLOW:
        return False
    return any(n.endswith(p) or n == p.lstrip("_") for p in _SECRET_KEY_PATTERNS)


def _scrub_value(key, value):
    """Mask secret-shaped leaves, recursing into nested dicts/lists so a secret
    stored under a non-secret parent key (e.g.
    ``{"email_account": {"smtp_password": "..."}}``) is still blanked. Only
    non-empty *string* values are blanked; presence is preserved."""
    if isinstance(value, dict):
        return {
            k: ("" if (is_secret_key(k) and isinstance(v, str) and v)
                else _scrub_value(k, v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub_value(key, item) for item in value]
    if is_secret_key(key) and isinstance(value, str) and value:
        return ""
    return value


def scrub_settings(settings: dict) -> dict:
    """Return a copy of ``settings`` with secret-shaped values masked (deep)."""
    return {k: _scrub_value(k, v) for k, v in (settings or {}).items()}


# ---------------------------------------------------------------------------
# Memory-for-egress scrubbing (egress firewall §4 — memory-dict counterpart of
# prompt_security.sensitivity_tag). A memory entry sourced from the personal
# domain must never egress verbatim; it is dropped to a tag + abstract so a
# delegation prompt can still reference *that* a memory exists without leaking
# its content. Secret-shaped leaves are additionally blanked via scrub_settings.
# ---------------------------------------------------------------------------

# Provenance prefixes that mark a memory as personal-domain (sensitive). Mirrors
# ``prompt_security.SENSITIVE_SOURCE_ROOTS``; Odysseus Documents carry
# ``source_email_*`` provenance, so a prefix match is the structural signal.
SOURCE_SENSITIVE_PREFIXES = (
    "source_email_", "source_contact_", "source_calendar_", "source_chat_",
    "source_comms_", "source_personal_",
)


def _is_sensitive_source(source: str) -> bool:
    s = (source or "").lower()
    return any(s.startswith(p) for p in SOURCE_SENSITIVE_PREFIXES)


def scrub_memory_for_egress(memory):
    """Return an egress-safe copy of a memory entry.

    If the entry's ``source`` is a sensitive-provenance prefix, its ``text`` is
    replaced with an abstract placeholder (the content does not egress); the
    category/id survive so a sanitized delegation prompt can note its existence.
    Regardless of provenance, secret-shaped leaves are blanked (deep). Never
    raises — a malformed entry passes through ``scrub_settings`` unchanged."""
    if not isinstance(memory, dict):
        return memory
    out = scrub_settings(memory)
    if _is_sensitive_source(str(out.get("source", ""))):
        cat = out.get("category", "memory")
        out["text"] = f"<redacted: sensitive {cat} memory — not egress-eligible>"
        out["egress_redacted"] = True
    return out
