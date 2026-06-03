/**
 * runTerminal.js — live attach to a workforce run's tool-call stream (MIGRATION_PLAN
 * §7 / P5-T6). Opens an EventSource on the same-origin SSE proxy
 * (/api/aios/runs/{id}/stream → panel /api/runs/{id}/stream, tailing tool-calls.jsonl)
 * and appends each line to a log view. Follows the research/jobs.js EventSource
 * pattern (open, onmessage, onerror→close+fallback). Standalone (not the poll shell)
 * so the SSE lifecycle is tied to open/close.
 */
import { API_BASE, esc } from './aiosShell.js';

let _open = false;
let _esc = null;
let _es = null;
let _runId = null;

function _append(text) {
  const log = document.querySelector('#aios-terminal-modal .rt-log');
  if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const line = document.createElement('div');
  line.className = 'rt-line';
  line.textContent = text;            // textContent — no HTML injection from stream
  log.appendChild(line);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function _connect() {
  if (_es) { _es.close(); _es = null; }
  const es = new EventSource(`${API_BASE}/api/aios/runs/${encodeURIComponent(_runId)}/stream`);
  _es = es;
  es.onmessage = (evt) => {
    try {
      const d = JSON.parse(evt.data);
      if (d.line != null) _append(d.line);
      else if (d.error) _append(`[stream error: ${d.error}]`);
    } catch {
      if (evt.data) _append(evt.data);
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects; surface a notice but don't spam.
    const status = document.querySelector('#aios-terminal-modal .rt-status');
    if (status) status.textContent = 'reconnecting…';
  };
  es.onopen = () => {
    const status = document.querySelector('#aios-terminal-modal .rt-status');
    if (status) status.textContent = 'live';
  };
}

export function openRunTerminal(runId) {
  if (_open) closeRunTerminal();
  _open = true;
  _runId = runId;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'aios-terminal-modal';
  modal.innerHTML = `
    <div class="modal-content aios-modal-content" style="width:min(760px,94vw);">
      <div class="modal-header">
        <h4>Run ${esc(runId)} <span class="rt-status" style="font-size:11px;opacity:0.6;">connecting…</span></h4>
        <span style="flex:1"></span>
        <button class="close-btn" id="aios-terminal-close">✖</button>
      </div>
      <div class="modal-body" style="overflow:hidden;">
        <div class="rt-log" style="font-family:var(--mono,monospace);font-size:12px;white-space:pre-wrap;
             background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;
             height:60vh;overflow:auto;"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('aios-terminal-close').addEventListener('click', closeRunTerminal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeRunTerminal(); });
  _esc = (e) => { if (e.key === 'Escape') closeRunTerminal(); };
  document.addEventListener('keydown', _esc);

  _connect();
}

export function closeRunTerminal() {
  if (!_open) return;
  _open = false;
  if (_es) { _es.close(); _es = null; }
  const modal = document.getElementById('aios-terminal-modal');
  if (modal) {
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => modal.remove(), { once: true });
      setTimeout(() => { if (modal.parentElement) modal.remove(); }, 250);
    } else { modal.remove(); }
  }
  if (_esc) { document.removeEventListener('keydown', _esc); _esc = null; }
  _runId = null;
}

export function isRunTerminalOpen() { return _open; }

export default { openRunTerminal, closeRunTerminal, isRunTerminalOpen };
