const paths = {
  library: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 11v7m-3-4h6"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  window: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  pan: '<path d="M12 3v18M3 12h18m-12-6 3-3 3 3m-6 12 3 3 3-3m3-9 3 3-3 3M6 9l-3 3 3 3"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5M7 10.5h7m-3.5-3.5v7"/>',
  probe: '<circle cx="12" cy="12" r="4"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/>',
  distance: '<path d="m4 16 12-12 4 4L8 20zM9 11l2 2m1-5 2 2m1-5 2 2m-11 7 2 2"/>',
  reset: '<path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7"/>',
  rotate: '<path d="M3 10a9 9 0 1 1 2 9M3 3v7h7"/><path d="m11 8 5 4-5 4z"/>',
  flip: '<path d="M12 3v18M3 6l6 6-6 6zm18 0-6 6 6 6z"/>',
  invert: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>',
  play: '<path d="m8 4 12 8-12 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5v14M17 5v14" stroke-width="4"/>',
  previous: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  inspector: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M6 8h6m-6 4h6m-6 4h4"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  chevron: '<path d="m8 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-1 .5-1 1-1 2M12 17h.01"/>',
  warning: '<path d="m12 3 10 18H2zM12 9v5m0 3h.01"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};

export function icon(name, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.layers}</svg>`;
}
