/**
 * Volume Overlay
 * OSD de volume façon TV des années 90 : le mot « VOLUME » + une barre faite
 * UNIQUEMENT de caractères — des « | » verts vifs pour le niveau atteint, des
 * « - » sombres pour le reste. Pas de fond, juste du texte (comme une vraie
 * incrustation cathodique). Superposé PAR-DESSUS tout (film ou YouTube), il
 * s'efface après un court délai d'inactivité.
 */

const SEGMENTS = 20; // 1 « | » = 5 %
const HIDE_MS = 1400;

export class VolumeOverlay {
  constructor() {
    this.root = null;
    this.hideTimer = null;
  }

  init() {
    const root = document.createElement('div');
    root.id = 'volume-osd';
    root.innerHTML = `
      <div class="vol-label">Volume</div>
      <div class="vol-bar"><span class="vol-on"></span><span class="vol-off"></span></div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.onEl = root.querySelector('.vol-on');
    this.offEl = root.querySelector('.vol-off');
    return this;
  }

  /** Affiche le niveau (0..100) et réarme l'extinction. */
  show(percent) {
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    const on = Math.round((pct / 100) * SEGMENTS);
    this.onEl.textContent = '|'.repeat(on);
    this.offEl.textContent = '-'.repeat(SEGMENTS - on);
    this.root.classList.add('open');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.root.classList.remove('open'), HIDE_MS);
  }
}

export default VolumeOverlay;
