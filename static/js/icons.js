/**
 * icons.js — one canonical inline-SVG icon set for the AIOS Workshop cockpit.
 *
 * Single source of truth shared by workshop.js + board.js (previously each
 * carried its own `_IC` map with the `brain` path duplicated literally). Stroke
 * icons (stroke=currentColor) so they inherit the theme accent; no emoji.
 *
 *   ic(name)        → 15px .ck-ic glyph
 *   ic(name, cls)   → same with an extra class (e.g. a sizing modifier)
 */
const _IC = {
  // workshop.js set
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/>',
  cancel: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  branch: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="7" r="2.4"/><path d="M6 8.4v7.2M18 9.4c0 4.2-5.4 2.4-6 5.6"/>',
  brain: '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.6A3 3 0 0 0 6 18a3 3 0 0 0 6 .5V4.5A3 3 0 0 0 9 3z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.6A3 3 0 0 1 18 18a3 3 0 0 1-6 .5"/>',
  bolt: '<path d="M13 3L5 13h5l-1 8 8-10h-5z" fill="currentColor" stroke="none"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  // board.js set
  merge: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><path d="M6 8.4v7.2M18 11.2c0 3-4 2.6-6 4.4"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  link: '<path d="M9 15l6-6"/><path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1"/><path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export function ic(name, cls) {
  return `<svg class="ck-ic ${cls || ''}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${_IC[name] || ''}</svg>`;
}

export default { ic };
