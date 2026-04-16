// Minimal inline SVG icons (lucide-style). No runtime dep.
const svg = (paths: string, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const Icons = {
  brand: svg(
    '<circle cx="7" cy="7" r="3.2"/><circle cx="17" cy="8" r="2.6"/><circle cx="9" cy="17" r="2.8"/><circle cx="17.5" cy="17" r="2"/>',
    20,
  ),
  play: svg('<polygon points="6 4 20 12 6 20 6 4"/>'),
  zap: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  cube: svg(
    '<path d="M12 2 L3 7 L3 17 L12 22 L21 17 L21 7 Z"/><path d="M3 7 L12 12 L21 7"/><path d="M12 12 L12 22"/>',
  ),
  splat: svg(
    '<circle cx="7" cy="8" r="3"/><circle cx="16" cy="9" r="2.3"/><circle cx="9" cy="16" r="2.5"/><circle cx="17" cy="16.5" r="2"/><circle cx="12" cy="12" r="1.3"/>',
  ),
  points: svg(
    '<circle cx="5" cy="5" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="19" cy="5" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="19" r="1"/><circle cx="12" cy="19" r="1"/><circle cx="19" cy="19" r="1"/>',
  ),
  depth: svg(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 10 H21"/><path d="M3 15 H21"/>',
  ),
  normal: svg('<path d="M12 3 L12 21"/><path d="M3 12 L21 12"/><path d="M7 7 L17 17"/><path d="M17 7 L7 17"/>'),
  video: svg('<path d="M23 7 L16 11 L23 15 Z"/><rect x="1" y="5" width="15" height="14" rx="2"/>'),
  folder: svg('<path d="M3 7 L10 7 L12 9 L21 9 A1 1 0 0 1 22 10 L22 18 A1 1 0 0 1 21 19 L3 19 A1 1 0 0 1 2 18 L2 8 A1 1 0 0 1 3 7 Z"/>'),
  terminal: svg('<polyline points="4 7 9 12 4 17"/><line x1="11" y1="19" x2="20" y2="19"/>'),
  camera: svg('<path d="M23 19 A2 2 0 0 1 21 21 H3 A2 2 0 0 1 1 19 V8 A2 2 0 0 1 3 6 H7 L9 3 H15 L17 6 H21 A2 2 0 0 1 23 8 Z"/><circle cx="12" cy="13" r="4"/>'),
  upload: svg('<path d="M21 15 V19 A2 2 0 0 1 19 21 H5 A2 2 0 0 1 3 19 V15"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>', 24),
  download: svg('<path d="M21 15 V19 A2 2 0 0 1 19 21 H5 A2 2 0 0 1 3 19 V15"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  close: svg('<line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>'),
  chevronUp: svg('<polyline points="6 15 12 9 18 15"/>'),
  chevronDown: svg('<polyline points="6 9 12 15 18 9"/>'),
  chevronLeft: svg('<polyline points="15 18 9 12 15 6"/>', 20),
  chevronRight: svg('<polyline points="9 18 15 12 9 6"/>', 20),
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><polyline points="21 15 16 10 5 21"/>'),
  film: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="8" x2="21" y2="8"/><line x1="3" y1="16" x2="21" y2="16"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="16" y2="21"/>'),
  cpu: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="5"/><line x1="15" y1="2" x2="15" y2="5"/><line x1="9" y1="19" x2="9" y2="22"/><line x1="15" y1="19" x2="15" y2="22"/><line x1="2" y1="9" x2="5" y2="9"/><line x1="2" y1="15" x2="5" y2="15"/><line x1="19" y1="9" x2="22" y2="9"/><line x1="19" y1="15" x2="22" y2="15"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
  spinner: svg(
    '<path d="M12 3 A9 9 0 1 1 3 12" stroke-linecap="round"/>',
  ),
  refresh: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15 A9 9 0 0 0 21 12 A9 9 0 0 0 5.64 5.64 L1 10"/>'),
  trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6 L18 20 A2 2 0 0 1 16 22 H8 A2 2 0 0 1 6 20 L5 6"/><path d="M10 11 V17"/><path d="M14 11 V17"/><path d="M9 6 V4 A2 2 0 0 1 11 2 H13 A2 2 0 0 1 15 4 V6"/>'),
};

export type IconName = keyof typeof Icons;

/** Insert icon HTML inside any elements with [data-icon="name"]. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach(el => {
    const name = el.dataset.icon as IconName;
    const icon = Icons[name];
    if (icon) el.innerHTML = icon + el.innerHTML;
  });
}
