/**
 * Next Episode HUD
 * Pour un ÉPISODE de série en lecture : un bouton qui apparaît en bas de l'image
 * pour enchaîner. Deux régimes d'affichage, calqués sur le HUD de recalage des
 * sous-titres (SubtitleHud) :
 *   - en LECTURE : surgit au mouvement de la souris puis s'efface (idle),
 *     mais SEULEMENT une fois l'épisode « considéré comme vu » (≥ seuil) ;
 *   - en PAUSE   : reste affiché tant que la pause dure (le bouton fait partie
 *     de l'écran de pause), quel que soit l'avancement.
 *
 * Le libellé/action dépend de la disponibilité de l'épisode suivant :
 *   - suivant prêt → « ▶ Next SxxExx »  → émet 'next'
 *   - sinon        → « ☰ Episodes »     → émet 'episodes' (ouvre la liste)
 *
 * Émet : 'next' | 'episodes'
 */

import { EventEmitter } from './EventEmitter.js';

const IDLE_MS = 3000; // même délai d'inactivité que le HUD de sous-titres

export class NextEpisodeHud extends EventEmitter {
  constructor() {
    super();
    this.root = null;
    this.isEpisode = false; // le film courant est-il un épisode de série ?
    this.watched = false;   // épisode courant considéré comme vu ?
    this.paused = false;    // lecture en pause ?
    this.hasNext = false;   // un épisode suivant est-il prêt ?
    this.hideTimer = null;
    this.hovering = false;
  }

  init() {
    const root = document.createElement('div');
    root.id = 'next-ep-hud';
    root.innerHTML = `<button class="crt-btn ne-btn" type="button"></button>`;
    document.body.appendChild(root);
    this.root = root;
    this.btnEl = root.querySelector('.ne-btn');

    this.btnEl.addEventListener('click', () => {
      this.emit(this.hasNext ? 'next' : 'episodes');
    });
    // Tant que la souris est dessus, on ne s'efface pas sous le curseur.
    root.addEventListener('mouseenter', () => {
      this.hovering = true;
      clearTimeout(this.hideTimer);
    });
    root.addEventListener('mouseleave', () => {
      this.hovering = false;
      if (!this.paused) this.wake();
    });

    return this;
  }

  /**
   * Contexte du film courant.
   * @param {{isEpisode:boolean, hasNext:boolean, label:string}} info
   */
  setContext({ isEpisode = false, hasNext = false, label = '' } = {}) {
    this.isEpisode = isEpisode;
    this.hasNext = hasNext;
    this.btnEl.textContent = hasNext ? `▶ Next ${label}` : '☰ Episodes';
    this._refresh();
  }

  /** Épisode courant vu ou non (débloque l'apparition au mouvement en lecture). */
  setWatched(w) {
    if (this.watched === !!w) return;
    this.watched = !!w;
    this._refresh();
  }

  /** Lecture en pause : le bouton reste alors affiché en continu. */
  setPaused(p) {
    this.paused = !!p;
    this._refresh();
  }

  /** Mouvement de souris en lecture → affiche si l'épisode est vu, puis idle. */
  wake() {
    if (this.paused || !this.isEpisode || !this.watched) return;
    this._show();
    clearTimeout(this.hideTimer);
    if (this.hovering) return;
    this.hideTimer = setTimeout(() => this.hide(), IDLE_MS);
  }

  /** Recalcule la visibilité selon pause / épisode / vu. */
  _refresh() {
    if (!this.isEpisode) { this.hide(); return; }
    if (this.paused) {
      // En pause, le bouton fait partie de l'écran de pause : affichage continu.
      this._show();
      clearTimeout(this.hideTimer);
    } else if (!this.watched) {
      // En lecture avant le seuil « vu » : rien (l'apparition viendra de wake()).
      this.hide();
    }
  }

  _show() {
    if (this.root) this.root.classList.add('open');
  }

  hide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.root) this.root.classList.remove('open');
  }
}

export default NextEpisodeHud;
