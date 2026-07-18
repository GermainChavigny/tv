/**
 * Volume Overlay
 * OSD de volume façon TV des années 90 : le mot « VOLUME » + une rangée de
 * petits rectangles verts qui s'empilent selon le niveau. Superposé PAR-DESSUS
 * tout (film ou YouTube), il s'efface après un court délai d'inactivité.
 */

const SEGMENTS = 20; // 1 rectangle = 5 %
const HIDE_MS = 1400;

export class VolumeOverlay {
  constructor() {
    this.root = null;
    this.hideTimer = null;
  }

  init() {
    const root = document.createElement('div');
    root.id = 'volume-osd';
    const cells = Array.from({ length: SEGMENTS },
      () => '<span class="vol-seg"></span>').join('');
    root.innerHTML = `
      <div class="vol-label">Volume</div>
      <div class="vol-bar">${cells}</div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.segs = [...root.querySelectorAll('.vol-seg')];
    return this;
  }

  /** Affiche le niveau (0..100) et réarme l'extinction. */
  show(percent) {
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    const on = Math.round((pct / 100) * SEGMENTS);
    this.segs.forEach((s, i) => s.classList.toggle('on', i < on));
    this.root.classList.add('open');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.root.classList.remove('open'), HIDE_MS);
  }
}

export default VolumeOverlay;
