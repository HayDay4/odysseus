"""Egress firewall — the mechanical gate every remote (egress-zone) call passes.

Architecture: ``odysseus_eval/MIGRATION_PLAN.md`` §4. The Overlord (local model)
routes sensitivity *before* capability; this module is the **hard** half of that
wall — defense-in-depth that does not depend on the 7B model's judgment:

  1. ``secret_scan``   — refuse/redact credential-shaped content (no token ever
                         reaches a remote provider's logs).
  2. ``sensitivity_tag`` (in ``prompt_security``) — source/keyword classifier.
  3. ``gate``          — the composition: open + clean → auto-allow; sensitive →
                         needs_consent (the "Approve egress" UI shows the scrubbed
                         payload); a raw secret → never auto-allowed.

Single source of truth for the secret patterns lives HERE. They are a
copy-reference port of the AIOS workforce scanner ``lib/hermes_advise.py``
(``_SECRET_PATH_RE`` / ``_SECRET_VALUE_RES``) — overlord is a separate submodule
and must stay self-contained, so we vendor the patterns rather than cross-repo
import. Keep the two in lock-step: a new credential path/token shape added to
``lib/hermes_advise.py`` (and ``~/.claude/hooks/pre-bash.sh``) should be added here.

Deliberately stdlib-only and never raises — a gate that crashes is worse than no
gate (it must be importable + unit-testable without the FastAPI/Chroma chain).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Secret-shaped patterns — ported from lib/hermes_advise.py (keep in lock-step)
# ---------------------------------------------------------------------------

# Path references to known credential files.
SECRET_PATH_RE = re.compile(
    r"""(
        \.ssh/ | \.gnupg/ | \.aws/credentials
        | /\.config/gh/ | /\.config/github/\.env | /\.config/op/
        | /\.config/restic-password | /\.config/freqtrade/\.env
        | /\.config/unsplash/\.env | /\.config/pexels/\.env
        | /\.config/odysseus/\.env | /\.hermes/\.env
        | /channels/telegram/\.env
        | /\.claude/\.credentials\.json
        | id_rsa | id_ed25519 | id_ecdsa
        | \.pem | \.p12 | \.pfx | \.kdbx
    )""",
    re.VERBOSE,
)

# Secret-shaped VALUES the path guard can't catch when a token is pasted inline.
SECRET_VALUE_RES = (
    ("credential-assignment", re.compile(
        r"(?i)\b[A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|"
        r"PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)\b\s*[:=]\s*['\"]?[^\s'\"]{8,}")),
    ("prefixed-key", re.compile(r"\bsk-(?:ant-|or-)?[A-Za-z0-9_-]{16,}")),
    ("github-token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("aws-akid", re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("pem-block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    # Odysseus API token shape: ody_<base64ish>
    ("odysseus-token", re.compile(r"\body_[A-Za-z0-9_-]{20,}")),
    ("telegram-bot", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{32,}")),
)


def secret_scan(text: Optional[str]) -> List[str]:
    """Return matched secret-pattern labels (empty == clean). Never raises.

    Conservative by design: a false positive costs a blocked/scrubbed egress; a
    false negative leaks a credential into a remote provider's logs.
    """
    if not text:
        return []
    hits: List[str] = []
    if SECRET_PATH_RE.search(text):
        hits.append("credential-path")
    for label, rx in SECRET_VALUE_RES:
        if rx.search(text):
            hits.append(label)
    return hits


def redact_secrets(text: str) -> str:
    """Replace secret-shaped spans with placeholders. Result is clean under
    ``secret_scan``. Same goal as the scan (no secret reaches the provider),
    surgically applied so structural content still gets through. Never raises."""
    if not text:
        return text
    out = SECRET_PATH_RE.sub("<redacted-path>", text)
    for _, rx in SECRET_VALUE_RES:
        out = rx.sub("<redacted>", out)
    return out


# ---------------------------------------------------------------------------
# The gate — composition (sensitivity tag + secret scan + scrub)
# ---------------------------------------------------------------------------

def gate(text: str, *, source: Optional[str] = None) -> Dict[str, Any]:
    """Pre-egress verdict for a payload bound for a remote (egress-zone) model.

    Returns a dict::

        {
          "sensitive":     bool,   # source/keyword classifier said personal-domain
          "secrets":       [str],  # secret-pattern labels found in the raw text
          "scrubbed":      str,    # text with secret spans redacted (consent preview)
          "needs_consent": bool,   # sensitive → must pass the "Approve egress" UI
          "allow":         bool,   # auto-egress permitted (open AND no raw secret)
          "reasons":       [str],  # human-readable explanation
        }

    Policy (§4 defense-in-depth):
      • open + no secret           → allow (free egress).
      • sensitive                  → needs_consent (show scrubbed payload, ask diego).
      • any raw secret present     → never auto-allowed; must be scrubbed first.
    """
    # Lazy import keeps prompt_security a leaf (no import cycle at module load).
    from src.prompt_security import sensitivity_tag

    tag = sensitivity_tag(text, source=source)
    sensitive = tag == "sensitive"
    secrets = secret_scan(text)
    scrubbed = redact_secrets(text)

    reasons: List[str] = []
    if sensitive:
        reasons.append(f"sensitivity={tag} (source={source or 'inferred'})")
    if secrets:
        reasons.append("secret-shaped content: " + ", ".join(secrets))
    if not reasons:
        reasons.append("open, no credential-shaped content")

    return {
        "sensitive": sensitive,
        "secrets": secrets,
        "scrubbed": scrubbed,
        "needs_consent": sensitive,
        "allow": (not sensitive) and (not secrets),
        "reasons": reasons,
    }
