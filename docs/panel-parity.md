# Panel → Odysseus native parity checklist (MIGRATION_PLAN §7)

Tracks the rebuild of every AIOS panel view natively inside Odysseus. The panel
**API (`:17776`)** stays the permanent headless workforce backend; only the panel
**UI (`:17777`)** is retired — and **only after diego verifies parity** (P5-T9/T10
are NOT done in this code pass; they stop a live service → guardrail).

## Parity matrix

| §7 view | API source (via `/api/aios/*` proxy) | Native module | Status |
|---|---|---|---|
| Agents Roster + Budgets | `GET /api/agents/roster` | `agentsRoster.js` | ✅ built (unverified*) |
| Org tree | `GET /api/org` | `org.js` | ✅ built (unverified*) |
| Proposals (approve/reject) | `GET /api/agents/proposals` + POST | `proposals.js` | ✅ built (unverified*) |
| Brief / spawn | `POST /api/brief/spawn` | `brief.js` | ✅ built (unverified*) |
| Inbox drilldown | `GET /api/inbox` | `inbox.js` | ✅ built (unverified*) |
| Runs kanban (live state) | `GET /api/runs/active` + `/recent` | `runsKanban.js` | ✅ built (unverified*) |
| **RunTerminal (live attach)** | **NEW** SSE `GET /api/runs/{id}/stream` (tails `tool-calls.jsonl`, B7) | `runTerminal.js` | ✅ built (unverified*) |
| Launcher | — | `agentsHub.js` (one "Agents" rail button) | ✅ built |
| 3D mini-bridge | — | — | 🚫 dropped (decision D3) |
| Rich metrics visuals | — | — | 🚫 simplified/dropped |

`*unverified` = wired + syntax-checked, but not integration-tested tonight — needs
the panel API (`:17776`) and the Odysseus app (`:17778`) both running. See
`OVERNIGHT_REPORT.md`.

## Plumbing built

- `routes/agents_routes.py` — same-origin proxy `/api/aios/*` → panel `:17776`,
  incl. the SSE passthrough `/api/aios/runs/{id}/stream` (P5-T4). Path segments
  validated (`^[A-Za-z0-9_.-]+$`) + URL-encoded before forwarding.
- Panel `GET /api/runs/{run_id}` (P2-F) and `GET /api/runs/{run_id}/stream` (P5-T3,
  in `aios-panel/aios_panel/main.py`).
- Shared modal shell `aiosShell.js` (escape-on-attribute `esc`, `aiosGet/aiosPost`,
  poll lifecycle).

## Left for diego (NOT done — gated on verified parity)

1. Bring up the Odysseus app + panel API, open each native view, confirm parity
   against the live `:17777` panel.
2. **P5-T9** — decommission `:17777` (stop + disable the SvelteKit web service;
   keep artifacts). Stops a running service → not done autonomously.
3. **P5-T10** — update panel CORS after retirement.
