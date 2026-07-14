/**
 * Movie Controls
 * Overlay affiché QUAND le film est en PAUSE. Look décodeur rétro : en-tête
 * « PAUSED » + temps, rangées de réglages (chaque catégorie = un bouton qui
 * cycle ses valeurs), et la barre de progression cliquable EN BAS. Tout au curseur.
 *
 * Émet :
 *   'resume'                       reprendre la lecture
 *   'set-fit'      ('contain'|'cover')  letterbox 16:9 ⇄ crop 4:3
 *   'set-subtitles'('fr'|'en'|'off')    langue des sous-titres
 *   'subtitle-offset' (±secondes)       recalage des sous-titres (± 0,1 s)
 *   'set-audio'    (index)              piste audio
 *   'library'                      revenir à la bibliothèque
 *   'seek'         (ratio 0..1)     saut à une position (clic barre)
 */

import { EventEmitter } from './EventEmitter.js';
import { footerHtml, wireFooterNav } from './CrtFooter.js';

const SUB_LABELS = { off: 'None', fr: 'French', en: 'English' };

export class MovieControls extends EventEmitter {
  constructor() {
    super();
    this.root = null;
    this.isOpen = false;
    // État courant, sert à cycler chaque catégorie.
    this.fitMode = 'contain';
    this.subLangs = [];
    this.subMode = 'off';
    this.subOffset = 0;
    this.audioTracks = [];
    this.audioIndex = 0;
  }

  init() {
    const root = document.createElement('div');
    root.id = 'movie-controls';
    root.innerHTML = `
      <div class="mc-head">
        <span class="mc-paused">Paused</span>
        <span class="mc-time">00:00 / 00:00</span>
      </div>
      <div class="mc-body">
        <div class="mc-row mc-ratio">
          <span class="mc-label">Aspect Ratio</span>
          <button class="crt-btn mc-cycle" data-cycle="ratio" type="button">16:9</button>
        </div>
        <div class="mc-row mc-audio" style="display:none">
          <span class="mc-label">Audio Language</span>
          <button class="crt-btn mc-cycle" data-cycle="audio" type="button">—</button>
        </div>
        <div class="mc-row mc-subs">
          <span class="mc-label">Subtitle Language</span>
          <button class="crt-btn mc-cycle" data-cycle="subs" type="button">None</button>
        </div>
        <div class="mc-row mc-offset">
          <span class="mc-label">Subtitle Offset</span>
          <button class="crt-btn mc-off-btn" data-offset="-0.1" type="button">− 0.1s</button>
          <span class="mc-offset-val">0.0s</span>
          <button class="crt-btn mc-off-btn" data-offset="0.1" type="button">+ 0.1s</button>
        </div>
      </div>
      <div class="mc-seekbar crt-bar"><div class="mc-seekbar-fill crt-bar-fill"></div></div>
      ${footerHtml('<button class="crt-navbtn mc-resume" data-action="resume" type="button">[Resume]</button>')}
    `;
    document.body.appendChild(root);
    this.root = root;
    wireFooterNav(root, this);
    this.timeEl = root.querySelector('.mc-time');
    this.seekbar = root.querySelector('.mc-seekbar');
    this.seekFill = root.querySelector('.mc-seekbar-fill');
    this.audioRow = root.querySelector('.mc-audio');
    this.subsRow = root.querySelector('.mc-subs');
    this.offsetRow = root.querySelector('.mc-offset');
    this.ratioBtn = root.querySelector('[data-cycle="ratio"]');
    this.audioBtn = root.querySelector('[data-cycle="audio"]');
    this.subsBtn = root.querySelector('[data-cycle="subs"]');
    this.offsetVal = root.querySelector('.mc-offset-val');

    // Boutons : délégation unique sur la racine.
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !this.root.contains(btn)) return;
      if (btn.dataset.action) {
        if (btn.dataset.action === 'resume') this.hide();
        this.emit(btn.dataset.action);
      } else if (btn.dataset.cycle) {
        this._cycle(btn.dataset.cycle);
      } else if (btn.dataset.offset !== undefined) {
        this.emit('subtitle-offset', parseFloat(btn.dataset.offset));
      }
    });

    // Clic sur la barre → position 0..1 → reprise à cet endroit.
    this.seekbar.addEventListener('click', (e) => {
      const rect = this.seekbar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.seekFill.style.width = `${ratio * 100}%`;
      this.hide();
      this.emit('seek', ratio);
    });

    return this;
  }

  /** Passe à la valeur suivante d'une catégorie et émet le changement. */
  _cycle(kind) {
    if (kind === 'ratio') {
      this.emit('set-fit', this.fitMode === 'contain' ? 'cover' : 'contain');
    } else if (kind === 'subs') {
      const cycle = ['off', ...this.subLangs];
      const next = cycle[(cycle.indexOf(this.subMode) + 1) % cycle.length];
      this.emit('set-subtitles', next);
    } else if (kind === 'audio') {
      if (this.audioTracks.length < 2) return;
      const pos = this.audioTracks.findIndex((t) => t.index === this.audioIndex);
      const next = this.audioTracks[(pos + 1) % this.audioTracks.length];
      this.emit('set-audio', next.index);
    }
  }

  /**
   * Affiche l'overlay. `ratio` remplit la barre ; `elapsed`/`duration` (en
   * secondes) alimentent le temps si fournis.
   */
  show(ratio = 0, elapsed = null, duration = null) {
    this.seekFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    if (elapsed != null && duration != null) this.setTime(elapsed, duration);
    this.isOpen = true;
    this.root.classList.add('open');
  }

  hide() {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  setTime(elapsed, duration) {
    this.timeEl.textContent = `${fmtTime(elapsed)} / ${fmtTime(duration)}`;
  }

  /** Reflète le ratio courant sur le bouton (16:9 = letterbox, 4:3 = crop). */
  setFitActive(mode) {
    this.fitMode = mode;
    this.ratioBtn.textContent = mode === 'cover' ? '4:3' : '16:9';
  }

  /**
   * Langues de sous-titres disponibles : masque les rangées s'il n'y en a pas.
   * @param {string[]} langs  ex. ['fr','en'] ; vide → rangées masquées.
   */
  setSubtitlesAvailable(langs) {
    this.subLangs = langs || [];
    const has = this.subLangs.length > 0;
    this.subsRow.style.display = has ? '' : 'none';
    this.offsetRow.style.display = has ? '' : 'none';
  }

  /** Reflète la langue de sous-titres courante sur le bouton. */
  setSubtitleActive(mode) {
    this.subMode = mode;
    this.subsBtn.textContent = SUB_LABELS[mode] || 'None';
  }

  /** Affiche le décalage courant entre les deux boutons ±. */
  setSubtitleOffsetLabel(offset) {
    this.subOffset = offset || 0;
    this.offsetVal.textContent = fmtOffset(this.subOffset);
  }

  /**
   * Pistes audio disponibles. Rangée masquée si <= 1 piste.
   * @param {Array<{index:number,label:string}>} tracks
   * @param {number} activeIndex
   */
  setAudioTracks(tracks, activeIndex) {
    this.audioTracks = tracks || [];
    if (this.audioTracks.length <= 1) {
      this.audioRow.style.display = 'none';
      return;
    }
    this.audioRow.style.display = '';
    this.setAudioActive(activeIndex);
  }

  setAudioActive(index) {
    this.audioIndex = index;
    const t = this.audioTracks.find((x) => x.index === index);
    this.audioBtn.textContent = t ? t.label : '—';
  }
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** 0.3 → "+0.3s" ; 0 → "0.0s" ; -0.2 → "−0.2s". */
function fmtOffset(o) {
  const v = Math.round((o || 0) * 10) / 10;
  if (v > 0) return `+${v.toFixed(1)}s`;
  if (v < 0) return `−${Math.abs(v).toFixed(1)}s`;
  return '0.0s';
}

export default MovieControls;
