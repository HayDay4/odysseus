"""Unit tests for the egress firewall (src/egress_gate.py + the soft-half helpers
in src/prompt_security.py / src/settings_scrub.py).

Stdlib-only (unittest) so they run without the FastAPI/Chroma dependency chain:
    cd overlord && python3 -m unittest tests.test_egress_gate -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import egress_gate
from src.prompt_security import sensitivity_tag, egress_scrub
from src.settings_scrub import scrub_memory_for_egress, SOURCE_SENSITIVE_PREFIXES


class TestSecretScan(unittest.TestCase):
    def test_clean_text_is_empty(self):
        self.assertEqual(egress_gate.secret_scan("refactor the runs kanban view"), [])

    def test_empty_input(self):
        self.assertEqual(egress_gate.secret_scan(""), [])
        self.assertEqual(egress_gate.secret_scan(None), [])

    def test_anthropic_key(self):
        self.assertIn("prefixed-key", egress_gate.secret_scan("key sk-ant-abc123DEF456ghi789jkl"))

    def test_openrouter_key(self):
        self.assertIn("prefixed-key", egress_gate.secret_scan("sk-or-v1-0123456789abcdef0123"))

    def test_github_token(self):
        self.assertIn("github-token", egress_gate.secret_scan("ghp_ABCDEFGHIJ0123456789abcdefXYZ"))

    def test_aws_akid(self):
        self.assertIn("aws-akid", egress_gate.secret_scan("AKIA1234567890ABCDEF"))

    def test_pem_block(self):
        self.assertIn("pem-block", egress_gate.secret_scan("-----BEGIN OPENSSH PRIVATE KEY-----"))

    def test_credential_assignment(self):
        self.assertIn("credential-assignment", egress_gate.secret_scan('OPENAI_API_KEY="hunter2sekret"'))

    def test_odysseus_token(self):
        self.assertIn("odysseus-token", egress_gate.secret_scan("bearer ody_abcdef0123456789ABCDEF"))

    def test_credential_path(self):
        self.assertIn("credential-path", egress_gate.secret_scan("cat ~/.ssh/id_ed25519"))


class TestRedact(unittest.TestCase):
    def test_redaction_is_clean(self):
        dirty = "token sk-ant-abc123DEF456ghi789jkl and ~/.aws/credentials"
        clean = egress_gate.redact_secrets(dirty)
        self.assertEqual(egress_gate.secret_scan(clean), [])
        self.assertIn("<redacted", clean)

    def test_redact_preserves_structure(self):
        self.assertEqual(egress_gate.redact_secrets("plain prose"), "plain prose")

    def test_egress_scrub_wrapper(self):
        # prompt_security.egress_scrub lazy-imports egress_gate.redact_secrets
        out = egress_scrub("ghp_ABCDEFGHIJ0123456789abcdefXYZ")
        self.assertEqual(egress_gate.secret_scan(out), [])


class TestSensitivityTag(unittest.TestCase):
    def test_source_provenance_wins(self):
        self.assertEqual(sensitivity_tag("anything", source="email"), "sensitive")
        self.assertEqual(sensitivity_tag("anything", source="source_email_inbox"), "sensitive")
        self.assertEqual(sensitivity_tag("anything", source="calendar_primary"), "sensitive")

    def test_open_source(self):
        self.assertEqual(sensitivity_tag("fix the build", source="code"), "open")
        self.assertEqual(sensitivity_tag("fix the build", source="repo"), "open")

    def test_keyword_fallback_personal(self):
        self.assertEqual(sensitivity_tag("my password is on a sticky note"), "sensitive")
        self.assertEqual(sensitivity_tag("here is my home address"), "sensitive")

    def test_email_in_text(self):
        self.assertEqual(sensitivity_tag("ping alice@example.com about it"), "sensitive")

    def test_plain_work_text_is_open(self):
        self.assertEqual(sensitivity_tag("optimize the runs.db scandir loop"), "open")

    def test_empty(self):
        self.assertEqual(sensitivity_tag(""), "open")


class TestGate(unittest.TestCase):
    def test_open_clean_auto_allows(self):
        v = egress_gate.gate("refactor the kanban poll loop", source="code")
        self.assertTrue(v["allow"])
        self.assertFalse(v["needs_consent"])
        self.assertFalse(v["sensitive"])
        self.assertEqual(v["secrets"], [])

    def test_sensitive_needs_consent_not_allowed(self):
        v = egress_gate.gate("summarize my last email from the bank", source="email")
        self.assertTrue(v["sensitive"])
        self.assertTrue(v["needs_consent"])
        self.assertFalse(v["allow"])

    def test_secret_blocks_auto_allow(self):
        v = egress_gate.gate("deploy with ghp_ABCDEFGHIJ0123456789abcdefXYZ", source="code")
        self.assertFalse(v["allow"])
        self.assertIn("github-token", v["secrets"])
        # scrubbed preview is clean
        self.assertEqual(egress_gate.secret_scan(v["scrubbed"]), [])

    def test_reasons_present(self):
        v = egress_gate.gate("plain open task", source="code")
        self.assertTrue(v["reasons"])


class TestScrubMemoryForEgress(unittest.TestCase):
    def test_sensitive_source_redacts_text(self):
        m = {"id": "x1", "category": "contact", "source": "source_email_inbox",
             "text": "Alice Smith, alice@example.com, +1 555 123 4567"}
        out = scrub_memory_for_egress(m)
        self.assertTrue(out["egress_redacted"])
        self.assertNotIn("alice@example.com", out["text"])
        self.assertEqual(out["id"], "x1")  # id/category survive

    def test_open_source_text_survives(self):
        m = {"id": "y1", "category": "fact", "source": "ai_agent",
             "text": "the panel API lives on :17776"}
        out = scrub_memory_for_egress(m)
        self.assertNotIn("egress_redacted", out)
        self.assertEqual(out["text"], "the panel API lives on :17776")

    def test_secret_leaf_blanked_regardless(self):
        m = {"id": "z1", "source": "ai_agent", "smtp_password": "hunter2", "text": "ok"}
        out = scrub_memory_for_egress(m)
        self.assertEqual(out["smtp_password"], "")

    def test_malformed_passthrough(self):
        self.assertEqual(scrub_memory_for_egress("not a dict"), "not a dict")

    def test_prefixes_exported(self):
        self.assertIn("source_email_", SOURCE_SENSITIVE_PREFIXES)


if __name__ == "__main__":
    unittest.main()
