#!/usr/bin/env python3
# REVIEW BEFORE RUNNING
# =============================================================================
# This script migrates the PERSONAL/identity slice of the AIOS Markdown memory
# pool into the Overlord's Chroma store (collection `odysseus_memories`), per
# MIGRATION_PLAN §6 + task P3-A. It is privacy-critical: the PERSONAL-vs-TECHNICAL
# split (docs/memory-classification.md / P3-E) is diego's call (blocker B5) and
# MUST be reviewed before this is run with --apply. Default is --dry-run.
#
# Design (mirrors scripts/migrate_faiss_to_chroma.py):
#   • parse each memory .md (frontmatter + body),
#   • skip `status: superseded` and the MEMORY.md index,
#   • classify PERSONAL vs TECHNICAL — ONLY the PERSONAL slice migrates; technical
#     playbooks stay in the AIOS pool where the Claude workforce consumes them,
#   • text = FULL markdown (B4/D1 — preserve frontmatter + [[links]]),
#   • re-embed (never transplant vectors); dedup via vs.find_similar(0.72),
#   • append via MemoryManager.save(), then a single vs.rebuild().
#
# The pure functions (parse/classify/superseded/iter) are stdlib-only and
# unit-tested (tests/test_migrate_aios_memory.py). The heavy src.* imports are
# deferred into migrate() so importing this module for tests pulls no deps.
# =============================================================================

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DEFAULT_POOL = os.path.expanduser(
    "~/.claude/projects/-home-diego-Pulpit-Projekty/memory"
)

# --- PERSONAL-vs-TECHNICAL classification (P3-E; REVIEW BEFORE RUNNING) -------
# PERSONAL → migrates to the Overlord's local Chroma (sensitive, local-only).
# Everything else is TECHNICAL → stays in the AIOS pool for the Claude workforce.
PERSONAL_TYPES = {"user", "preference", "identity", "contact", "personal"}
PERSONAL_CATEGORIES = {"personal", "identity", "preferences"}
PERSONAL_FILE_STEMS = {"user_profile"}
SKIP_FILES = {"MEMORY.md"}


def _parse_frontmatter(text):
    """Return (meta: dict, body: str). Minimal stdlib YAML-frontmatter reader —
    only the scalar fields we classify on (name/description/category/status/type)
    plus an inline `categories: [a, b]` list. No PyYAML dependency."""
    meta = {}
    if not text.startswith("---"):
        return meta, text
    lines = text.splitlines()
    # find the closing '---' (first line is the opening one)
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return meta, text
    # Flatten: both top-level and metadata-nested scalars go into one dict. The
    # keys we classify on (name top-level; category/status/type under metadata)
    # don't collide, so nesting depth doesn't matter.
    for raw in lines[1:end]:
        if not raw.strip():
            continue
        key_val = raw.strip()
        m = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", key_val)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if key in ("name", "description", "category", "status", "type"):
            meta[key] = val.strip().strip('"').strip("'")
        elif key == "categories":
            inline = re.findall(r"[A-Za-z0-9_\-]+", val)
            if inline:
                meta["categories"] = inline
    return meta, "\n".join(lines[end + 1:])


def is_superseded(meta):
    return str(meta.get("status", "")).strip().lower() == "superseded"


def classify(meta, relpath):
    """'personal' (→ Chroma) or 'technical' (→ stays in AIOS pool). REVIEW: B5."""
    if str(meta.get("type", "")).strip().lower() in PERSONAL_TYPES:
        return "personal"
    if str(meta.get("category", "")).strip().lower() in PERSONAL_CATEGORIES:
        return "personal"
    stem = os.path.splitext(os.path.basename(relpath))[0]
    if stem in PERSONAL_FILE_STEMS:
        return "personal"
    return "technical"


def subdir_category(relpath):
    """Map subdir → category (root files → 'fact')."""
    parts = relpath.replace("\\", "/").split("/")
    return parts[0] if len(parts) > 1 else "fact"


def iter_memory_files(root):
    """Yield .md memory files under root, skipping the index + reflections/."""
    for dirpath, dirnames, filenames in os.walk(root):
        # don't descend into reflections/ (pending session narratives, not memory)
        dirnames[:] = [d for d in dirnames if d != "reflections"]
        for fn in sorted(filenames):
            if not fn.endswith(".md") or fn in SKIP_FILES:
                continue
            yield os.path.join(dirpath, fn)


def load_memory(path, root):
    """Parse one memory file into a record (pure — no embedding)."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    meta, _ = _parse_frontmatter(text)
    relpath = os.path.relpath(path, root)
    return {
        "path": path,
        "relpath": relpath,
        "meta": meta,
        "full": text,                       # B4: full markdown, links preserved
        "category": subdir_category(relpath),
        "superseded": is_superseded(meta),
        "klass": classify(meta, relpath),
    }


def collect(root):
    """Return (personal, technical, skipped) record lists for `root`."""
    personal, technical, skipped = [], [], []
    for path in iter_memory_files(root):
        rec = load_memory(path, root)
        if rec["superseded"]:
            skipped.append(rec)
        elif rec["klass"] == "personal":
            personal.append(rec)
        else:
            technical.append(rec)
    return personal, technical, skipped


def migrate(root=DEFAULT_POOL, *, dry_run=True, owner="diego", dedup_threshold=0.72):
    """Migrate the PERSONAL slice into Chroma. --dry-run (default) only reports."""
    personal, technical, skipped = collect(root)
    print(f"AIOS pool: {root}")
    print(f"  personal (→ Chroma): {len(personal)}")
    print(f"  technical (stays):   {len(technical)}")
    print(f"  skipped superseded:  {len(skipped)}")
    for rec in personal:
        print(f"    PERSONAL  {rec['relpath']}  [{rec['category']}]")

    if dry_run:
        print("\n--dry-run: no embedding, no writes. Re-run with --apply AFTER B5 sign-off.")
        return {"personal": len(personal), "technical": len(technical), "skipped": len(skipped)}

    # ---- impure path (deferred imports; mirrors migrate_faiss_to_chroma.py) ----
    from src.constants import DATA_DIR
    from src.memory import MemoryManager
    from src.memory_vector import MemoryVectorStore

    manager = MemoryManager(DATA_DIR)
    vs = MemoryVectorStore(DATA_DIR)
    existing = manager.load_all()
    added = 0
    for rec in personal:
        if vs.healthy and vs.find_similar(rec["full"], threshold=dedup_threshold):
            continue  # near-duplicate already present
        entry = manager.add_entry(
            rec["full"], source=f"aios_migration:{rec['relpath']}",
            category=rec["category"], owner=owner,
        )
        existing.append(entry)
        added += 1
    manager.save(existing)
    if vs.healthy:
        vs.rebuild(existing)
    print(f"\nMigrated {added} personal memories; rebuilt Chroma ({len(existing)} total).")
    return {"added": added, "total": len(existing)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Migrate AIOS personal memory → Chroma (REVIEW B5 first).")
    ap.add_argument("--root", default=DEFAULT_POOL, help="AIOS memory pool root.")
    ap.add_argument("--apply", action="store_true", help="Actually write (default: dry-run).")
    ap.add_argument("--owner", default="diego")
    args = ap.parse_args(argv)
    migrate(args.root, dry_run=not args.apply, owner=args.owner)


if __name__ == "__main__":
    main()
