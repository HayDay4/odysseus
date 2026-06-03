"""Unit tests for the PURE logic of scripts/migrate_aios_memory.py — frontmatter
parsing, superseded-skip, PERSONAL/TECHNICAL classification, full-markdown
preservation (B4), and collection. Never touches the real pool, never embeds,
never writes Chroma. Stdlib-only:

    cd overlord && python3 -m unittest tests.test_migrate_aios_memory -v
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import migrate_aios_memory as mig

USER_PROFILE = """---
name: user-profile
description: who diego is
metadata:
  type: user
  category: ai-os
  status: active
---

diego is the owner. Prefers [[ship-then-iterate]]. Lives in CachyOS.
"""

TECH_MEMORY = """---
name: freqtrade-status
description: paper trading state
metadata:
  category: automation
  status: active
---

Paper fleet of 20 bots. See [[dualmom-portfolio]].
"""

SUPERSEDED = """---
name: old-thing
description: outdated
metadata:
  category: ai-os
  status: superseded
---

This was replaced.
"""

PREF_MEMORY = """---
name: a-pref
description: a preference
metadata:
  type: preference
  category: models
  status: active
---

Final synthesis stays on Opus.
"""


class FakeVectorStore:
    """Stand-in for MemoryVectorStore — records calls, finds no duplicates."""
    def __init__(self):
        self.healthy = True
        self.rebuilt_with = None
        self.queries = []

    def find_similar(self, text, threshold=0.72):
        self.queries.append((text, threshold))
        return None

    def rebuild(self, memories):
        self.rebuilt_with = list(memories)


def _write_pool(root):
    os.makedirs(os.path.join(root, "ai-os"))
    os.makedirs(os.path.join(root, "automation"))
    os.makedirs(os.path.join(root, "models"))
    os.makedirs(os.path.join(root, "reflections", "pending"))
    with open(os.path.join(root, "user_profile.md"), "w") as f:
        f.write(USER_PROFILE)
    with open(os.path.join(root, "automation", "freqtrade_status.md"), "w") as f:
        f.write(TECH_MEMORY)
    with open(os.path.join(root, "ai-os", "old.md"), "w") as f:
        f.write(SUPERSEDED)
    with open(os.path.join(root, "models", "a_pref.md"), "w") as f:
        f.write(PREF_MEMORY)
    with open(os.path.join(root, "MEMORY.md"), "w") as f:
        f.write("# index — should be skipped\n")
    with open(os.path.join(root, "reflections", "pending", "note.md"), "w") as f:
        f.write("---\nstatus: active\n---\nshould be skipped (reflections/)\n")


class TestFrontmatter(unittest.TestCase):
    def test_parse_nested(self):
        meta, body = mig._parse_frontmatter(USER_PROFILE)
        self.assertEqual(meta["type"], "user")
        self.assertEqual(meta["category"], "ai-os")
        self.assertEqual(meta["status"], "active")
        self.assertIn("diego is the owner", body)

    def test_no_frontmatter(self):
        meta, body = mig._parse_frontmatter("just text, no fm")
        self.assertEqual(meta, {})
        self.assertEqual(body, "just text, no fm")

    def test_superseded(self):
        meta, _ = mig._parse_frontmatter(SUPERSEDED)
        self.assertTrue(mig.is_superseded(meta))
        meta2, _ = mig._parse_frontmatter(USER_PROFILE)
        self.assertFalse(mig.is_superseded(meta2))


class TestClassify(unittest.TestCase):
    def test_user_type_is_personal(self):
        meta, _ = mig._parse_frontmatter(USER_PROFILE)
        self.assertEqual(mig.classify(meta, "user_profile.md"), "personal")

    def test_preference_type_is_personal(self):
        meta, _ = mig._parse_frontmatter(PREF_MEMORY)
        self.assertEqual(mig.classify(meta, "models/a_pref.md"), "personal")

    def test_technical_default(self):
        meta, _ = mig._parse_frontmatter(TECH_MEMORY)
        self.assertEqual(mig.classify(meta, "automation/freqtrade_status.md"), "technical")

    def test_filename_stem_personal(self):
        self.assertEqual(mig.classify({}, "user_profile.md"), "personal")


class TestCollect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        _write_pool(self.tmp)

    def test_collect_splits_correctly(self):
        personal, technical, skipped = mig.collect(self.tmp)
        pnames = {r["relpath"] for r in personal}
        # user_profile.md (type=user) + models/a_pref.md (type=preference)
        self.assertIn("user_profile.md", pnames)
        self.assertIn(os.path.join("models", "a_pref.md"), pnames)
        self.assertEqual(len(personal), 2)
        # superseded skipped
        self.assertEqual(len(skipped), 1)
        # technical = freqtrade_status only (MEMORY.md + reflections excluded)
        tnames = {r["relpath"] for r in technical}
        self.assertIn(os.path.join("automation", "freqtrade_status.md"), tnames)
        self.assertEqual(len(technical), 1)

    def test_index_and_reflections_skipped(self):
        all_paths = list(mig.iter_memory_files(self.tmp))
        bases = {os.path.basename(p) for p in all_paths}
        self.assertNotIn("MEMORY.md", bases)
        self.assertNotIn("note.md", bases)  # reflections/ pruned

    def test_full_markdown_preserved(self):
        personal, _, _ = mig.collect(self.tmp)
        up = next(r for r in personal if r["relpath"] == "user_profile.md")
        # B4: full markdown incl. frontmatter AND [[links]] survive verbatim
        self.assertTrue(up["full"].startswith("---"))
        self.assertIn("[[ship-then-iterate]]", up["full"])

    def test_subdir_category(self):
        self.assertEqual(mig.subdir_category(os.path.join("automation", "x.md")), "automation")
        self.assertEqual(mig.subdir_category("root.md"), "fact")


if __name__ == "__main__":
    unittest.main()
