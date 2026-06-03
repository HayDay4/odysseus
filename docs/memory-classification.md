# Memory classification — PERSONAL vs TECHNICAL (REVIEW BEFORE RUNNING)

> **Blocker B5 (privacy-critical).** This split decides which AIOS memories
> egress-class boundary they fall on. `scripts/migrate_aios_memory.py` consumes
> these rules to move the **PERSONAL** slice into the Overlord's local Chroma
> (`odysseus_memories`) while leaving **TECHNICAL** playbooks in the AIOS pool for
> the Claude workforce. **diego must review and sign off before `--apply`.**
> The script defaults to `--dry-run`; it was written but never run.

## The wall (MIGRATION_PLAN §6)

- **PERSONAL → Overlord Chroma (local, sensitive, never egress-eligible):**
  identity, preferences, personal facts, contacts, conversation history.
- **TECHNICAL → AIOS Markdown pool (non-sensitive, work-domain):** engineering /
  trading playbooks, infra notes, project state — consumed by the Claude
  workforce via `brief-task`, injected into delegation prompts.

The Overlord reads both pools; **only TECHNICAL is egress-eligible.**

## Rules as implemented (`migrate_aios_memory.classify`)

A memory is **PERSONAL** if ANY of:

| Signal | Value |
|---|---|
| `metadata.type` | `user`, `preference`, `identity`, `contact`, `personal` |
| `metadata.category` | `personal`, `identity`, `preferences` |
| filename stem | `user_profile` |

Everything else is **TECHNICAL**. `status: superseded` is skipped entirely;
`MEMORY.md` (the index) and `reflections/` (session narratives) are excluded.

## What this means for the current AIOS pool

The AIOS pool (`~/.claude/projects/-home-diego-Pulpit-Projekty/memory/`) is almost
entirely the **Work domain** — its subdirs (`ai-os/`, `automation/`, `hardware/`,
`hermes/`, `models/`, `persistence/`, `security/`, `web-dev/`, `telegram/`) are
technical. Expected PERSONAL matches today: **`user_profile.md`** and any entry
explicitly tagged `type: preference`/`identity`. The personal slice is small **by
design** — most of this pool should stay technical.

## Reviewer checklist (do before `--apply`)

1. Run `python3 scripts/migrate_aios_memory.py --dry-run` and read the
   `PERSONAL …` list it prints.
2. Confirm **nothing technical** is mis-tagged PERSONAL (would wrongly leave the
   workforce pool / become non-egress-eligible).
3. Confirm **nothing sensitive** is mis-tagged TECHNICAL (would stay egress-eligible
   — the dangerous direction). If any personal facts live under a technical subdir,
   add an explicit override here before applying.
4. Only then: `--apply` (re-embeds via fastembed; idempotent — dedup at 0.72).
