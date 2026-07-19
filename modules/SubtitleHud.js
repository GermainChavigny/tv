/**
 * Subtitle Offset HUD
 * Recalage des sous-titres SANS interrompre la lecture : petit panneau dans le
 * coin haut-droit qui apparaît dès que la souris bouge et s'efface après un
 * délai d'inactivité. Le film continue de tourner pendant les réglages, ce qui
 * permet de juger le décalage à l'oreille/à l'œil immédiatement.
 *
 * Émet :
 *   'subtitle-offset' (±secondes)  ajustement demandé (± 0,1 s)
 */

import { EventEmitter } from './EventEmitter.js';

// Délai d'inactivité (souris immobile) avant extinction du panneau.
const IDLE_MS = 3000;

export class SubtitleHud extends EventEmitter {
  constructor() {
    super();
    this.root = null;
    this.available = false; // le film courant a-t-il des sous-titres ?
    this.offset = 0;
    this.hideTimer = null;
    this.hovering = false; // la souris est-elle au-dessus du panneau ?
  }

  init() {
    const root = document.createElement('div');
    root.id = 'subtitle-hud';
    root.innerHTML = `
      <span class="sh-label">Subtitle Offset</span>
      <button class="crt-btn sh-btn" data-offset="-0.1" type="button">−</button>
      <span class="sh-val">0.0s</span>
      <button class="crt-btn sh-btn" data-offset="0.1" type="button">+</button>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.valEl = root.querySelector('.sh-val');

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-offset]');
      if (!btn) return;
      this.emit('subtitle-offset', parseFloat(btn.dataset.offset));
      this.wake(); // un réglage réarme le délai
    });

    // Tant que la souris est SUR le panneau, il ne doit pas s'effacer sous le
    // curseur (sinon on ne peut jamais viser un bouton tranquillement). On
    // suspend l'extinction à l'entrée, on la relance à la sortie.
    root.addEventListener('mouseenter', () => {
      this.hovering = true;
      clearTimeout(this.hideTimer);
    });
    root.addEventListener('mouseleave', () => {
      this.hovering = false;
      this.wake(); // repart pour un délai d'inactivité normal
    });

    return this;
  }

  /** Le HUD n'a de sens que si le film courant a des sous-titres. */
  setAvailable(ok) {
    this.available = !!ok;
    if (!this.available) this.hide();
  }

  /** Affiche le décalage courant entre les deux boutons. */
  setOffset(offset) {
    this.offset = offset || 0;
    this.valEl.textContent = fmtOffset(this.offset);
  }

  /** Mouvement de souris (ou clic) → affiche et réarme l'extinction. */
  wake() {
    if (!this.available) return;
    this.root.classList.add('open');
    clearTimeout(this.hideTimer);
    // Si la souris est posée sur le panneau, on le laisse ouvert indéfiniment
    // (l'extinction repartira au mouseleave). Sinon, délai d'inactivité normal.
    if (this.hovering) return;
    this.hideTimer = setTimeout(() => this.hide(), IDLE_MS);
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.root) this.root.classList.remove('open');
  }
}

/** 0.3 → "+0.3s" ; 0 → "0.0s" ; -0.2 → "−0.2s". */
function fmtOffset(o) {
  const v = Math.round((o || 0) * 10) / 10;
  if (v > 0) return `+${v.toFixed(1)}s`;
  if (v < 0) return `−${Math.abs(v).toFixed(1)}s`;
  return '0.0s';
}

export default SubtitleHud;
