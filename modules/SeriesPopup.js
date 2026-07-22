/**
 * Series Popup
 * Gestion d'une série : onglets de saisons + liste d'épisodes (gauche) et volet
 * d'information de l'épisode sélectionné (droite : vignette, synopsis, état,
 * action). Télécharger un épisode / la saison / la série ; lire un épisode obtenu.
 *
 * Émet :
 *   'play-episode' ({showId, season, episode})
 *   'nav-*'        raccourcis de pied de page (via CrtFooter)
 */

import { EventEmitter } from './EventEmitter.js';
import { footerHtml, wireFooterNav } from './CrtFooter.js';
import { reveal } from './RetroFx.js';

const POLL_MS = 1500;

// Icône + libellé par état d'épisode (repli DejaVu couvre ces glyphes).
const STATE = {
  ready: { icon: '▶', label: 'Available' },
  watched: { icon: '✓', label: 'Watched' },
  downloading: { icon: '…', label: 'Downloading…' },
  error: { icon: '!', label: 'Failed' },
  missing: { icon: '+', label: 'Not downloaded' },
};

export class SeriesPopup extends EventEmitter {
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.root = null;
    this.isOpen = false;
    this.show = null;
    this.season = null;
    this.episodes = [];      // épisodes de la saison courante (avec état)
    this.selectedEp = null;
    this.pollTimer = null;
    this._requested = new Set(); // épisodes cliqués, en attente du statut serveur
  }

  init() {
    const root = document.createElement('div');
    root.id = 'series-popup';
    root.innerHTML = `
      <div class="crt-header">
        <span class="crt-title sp-title"></span>
        <span class="crt-clock-wrap"><span class="crt-clock"></span><span class="crt-weather"></span><span class="crt-date"></span></span>
      </div>
      <div class="sp-body">
        <div class="sp-left">
          <div class="sp-seasons"></div>
          <div class="sp-episodes"></div>
        </div>
        <div class="sp-detail is-empty"></div>
      </div>
      <div class="sp-notice"></div>
      <div class="sp-actions">
        <button class="crt-btn sp-dl-season" type="button">Download season</button>
        <button class="crt-btn sp-dl-series" type="button">Download series</button>
      </div>
      ${footerHtml('<button class="crt-navbtn sp-back" type="button">[Back]</button>')}
    `;
    document.body.appendChild(root);

    this.root = root;
    this.titleEl = root.querySelector('.sp-title');
    this.seasonsEl = root.querySelector('.sp-seasons');
    this.episodesEl = root.querySelector('.sp-episodes');
    this.detailEl = root.querySelector('.sp-detail');
    this.noticeEl = root.querySelector('.sp-notice');

    wireFooterNav(root, this);
    root.querySelector('.sp-back').addEventListener('click', () => this.close());
    root.querySelector('.sp-dl-season').addEventListener('click', () => {
      if (this.season != null) this._download('season', this.season);
    });
    root.querySelector('.sp-dl-series').addEventListener('click', () => this._download('series'));

    this.seasonsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-season]');
      if (btn) this._selectSeason(Number(btn.dataset.season));
    });
    // Clic sur un épisode → le sélectionne (volet d'info à droite).
    this.episodesEl.addEventListener('click', (e) => {
      const row = e.target.closest('.sp-ep');
      if (row) this._selectEpisode(Number(row.dataset.ep));
    });

    return this;
  }

  /** Ouvre la popup sur une série (entrée library type 'series'). */
  open(show, { season = null, episode = null } = {}) {
    this.show = show;
    // Pré-sélection (reprise) : saison + épisode où l'on s'est arrêté. À défaut,
    // première saison, premier épisode.
    this.selectedEp = episode;
    this._scrollToSelected = episode != null; // amener l'épisode repris dans la vue
    this._requested.clear();
    this.titleEl.textContent = show.title || show.id;
    this._setNotice(null);
    this._renderSeasons();
    const seasons = show.seasons || [];
    const first = seasons[0] ? seasons[0].seasonNumber : 1;
    const target = (season != null && seasons.some((s) => s.seasonNumber === season))
      ? season : first;
    this._selectSeason(target, true); // garde selectedEp (reprise)
    this.isOpen = true;
    this.root.classList.add('open');
    reveal(this.root, { selector: '.sp-seasons, .sp-actions, .crt-header' });
    this._startPolling();
  }

  close() {
    this.isOpen = false;
    this._stopPolling();
    this.root.classList.remove('open');
  }

  _renderSeasons() {
    const seasons = this.show.seasons || [];
    this.seasonsEl.innerHTML = seasons.map((s) =>
      `<button class="sp-season" data-season="${s.seasonNumber}" type="button">S${s.seasonNumber}</button>`
    ).join('');
  }

  async _selectSeason(n, keepEp = false) {
    this.season = n;
    // Changement manuel de saison → on repart du 1er épisode ; à l'ouverture en
    // reprise (keepEp), on conserve l'épisode pré-sélectionné s'il existe.
    if (!keepEp) this.selectedEp = null;
    for (const b of this.seasonsEl.querySelectorAll('.sp-season')) {
      b.classList.toggle('is-active', Number(b.dataset.season) === n);
    }
    this.episodesEl.innerHTML = '<div class="sp-msg">Loading…</div>';
    await this._loadSeason();
  }

  async _loadSeason() {
    if (this.season == null) return;
    let view;
    try {
      view = await this.apiClient.getSeriesSeason(this.show.id, this.season);
    } catch {
      this.episodesEl.innerHTML = '<div class="sp-msg">Season unavailable</div>';
      return;
    }
    if (!this.isOpen || view.season !== this.season) return; // saison changée entre-temps
    this._setNotice(view.notice);
    this.episodes = view.episodes || [];
    this._renderEpisodes();
  }

  _effState(e) {
    // Épisode cliqué mais statut serveur pas encore rafraîchi → « downloading ».
    return (e.state === 'missing' && this._requested.has(`${this.season}x${e.ep}`))
      ? 'downloading' : e.state;
  }

  _renderEpisodes() {
    const eps = this.episodes;
    // L'en-tête est réservé au titre de la série : la saison active est déjà
    // surlignée dans sa barre, et l'état de chaque épisode est sur sa ligne.
    if (!eps.length) {
      this.episodesEl.innerHTML = '<div class="sp-msg">No episodes</div>';
      this._renderDetail(null);
      return;
    }
    this.episodesEl.innerHTML = eps.map((e) => {
      const st = this._effState(e);
      // Épisode déjà vu → coche à la place du ▶ (repère de progression dans la série).
      const seen = st === 'ready' && e.watched;
      // En cours → on montre le % (même 0 %) à la place de l'icône « … ».
      const stateCell = st === 'downloading'
        ? `${Math.round((e.progress || 0) * 100)}%`
        : (STATE[seen ? 'watched' : st] || {}).icon || '';
      // Couleur du % : cyan en téléchargement, vert en conversion (comme les films).
      const conv = st === 'downloading' && e.phase === 'transcoding' ? ' sp-ep--converting' : '';
      return `
        <div class="sp-ep sp-ep--${st}${conv}${seen ? ' sp-ep--watched' : ''}" data-ep="${e.ep}">
          <span class="sp-ep-state">${stateCell}</span>
          <span class="sp-ep-num">E${String(e.ep).padStart(2, '0')}</span>
          <span class="sp-ep-title">${escapeHtml(e.title || '')}</span>
        </div>`;
    }).join('');
    // Conserve la sélection si l'épisode existe encore, sinon prend le premier.
    const keep = eps.some((e) => e.ep === this.selectedEp);
    this._selectEpisode(keep ? this.selectedEp : eps[0].ep);
    // À l'ouverture en reprise, amène l'épisode pré-sélectionné dans la vue (une
    // seule fois : les rafraîchissements de statut ne doivent pas re-scroller).
    if (this._scrollToSelected) {
      this._scrollToSelected = false;
      const active = this.episodesEl.querySelector('.sp-ep.is-active');
      if (active) active.scrollIntoView({ block: 'center' });
    }
  }

  _selectEpisode(ep) {
    this.selectedEp = ep;
    for (const row of this.episodesEl.querySelectorAll('.sp-ep')) {
      row.classList.toggle('is-active', Number(row.dataset.ep) === ep);
    }
    this._renderDetail(this.episodes.find((e) => e.ep === ep) || null);
  }

  /** Volet d'info de l'épisode sélectionné : vignette, titre, état, action, synopsis. */
  _renderDetail(e) {
    if (!e) {
      this.detailEl.classList.add('is-empty');
      this.detailEl.innerHTML = 'Select an episode';
      return;
    }
    this.detailEl.classList.remove('is-empty');
    const st = this._effState(e);
    const seen = st === 'ready' && e.watched;
    const meta = STATE[seen ? 'watched' : st] || STATE.missing;
    const num = `S${String(this.season).padStart(2, '0')}E${String(e.ep).padStart(2, '0')}`;
    const action = st === 'ready'
      ? '<button class="crt-btn sp-play" type="button">▶ Play</button>'
      : st === 'downloading'
        ? ''  // pas d'action pendant le téléchargement (barre de progression à la place)
        : '<button class="crt-btn sp-get" type="button">Download episode</button>';

    // Ligne d'état : libellé + barre de progression si en cours.
    let stateBlock;
    if (st === 'downloading') {
      const pct = Math.round((e.progress || 0) * 100);
      const conv = e.phase === 'transcoding';
      stateBlock = `
        <div class="sp-d-state sp-d-state--${conv ? 'converting' : 'downloading'}">${phaseLabel(e.phase, pct)}</div>
        <div class="sp-d-prog"><span class="crt-bar mb-bar mb-bar--${conv ? 'convert' : 'download'}"><span class="crt-bar-fill" style="width:${pct}%"></span></span></div>`;
    } else if (st === 'ready') {
      // Épisode disponible → avancement de LECTURE (comme le volet film).
      const ratio = e.duration ? Math.max(0, Math.min(1, (e.currentTime || 0) / e.duration)) : 0;
      const time = e.duration
        ? `<div class="sp-d-time">${fmtTime(e.currentTime || 0)} / ${fmtTime(e.duration)}</div>`
        : '';
      stateBlock = `
        <div class="sp-d-state sp-d-state--${seen ? 'watched' : 'ready'}">${meta.icon} ${meta.label}</div>
        <div class="sp-d-prog">${time}<span class="crt-bar mb-bar mb-bar--seen"><span class="crt-bar-fill" style="width:${Math.round(ratio * 100)}%"></span></span></div>`;
    } else {
      stateBlock = `<div class="sp-d-state sp-d-state--${st}">${meta.icon} ${meta.label}</div>`;
    }

    this.detailEl.innerHTML = `
      <div class="sp-d-still">${e.still ? '<img draggable="false" alt="" />' : ''}</div>
      <div class="sp-d-num">${num}</div>
      <div class="sp-d-title">${escapeHtml(e.title || '')}</div>
      ${stateBlock}
      <div class="sp-d-action">${action}</div>
      ${e.overview ? `<div class="sp-d-overview">${escapeHtml(e.overview)}</div>` : ''}
    `;

    if (e.still) {
      const box = this.detailEl.querySelector('.sp-d-still');
      const img = box.querySelector('img');
      img.addEventListener('error', () => box.classList.add('no-poster'));
      img.src = e.still;
    }
    const play = this.detailEl.querySelector('.sp-play');
    if (play) play.addEventListener('click', () =>
      this.emit('play-episode', { showId: this.show.id, season: this.season, episode: e.ep }));
    const get = this.detailEl.querySelector('.sp-get');
    if (get) get.addEventListener('click', () => {
      this._requested.add(`${this.season}x${e.ep}`);
      this._download('episode', this.season, e.ep);
      this._renderEpisodes(); // reflète l'état « downloading » aussitôt
    });
  }

  _download(scope, season, episode) {
    // Retour immédiat : la recherche de sources tourne côté serveur et peut ne
    // rien trouver — sans ce message, un clic sans effet reste inexpliqué.
    this._setNotice('Searching sources…');
    this.apiClient.downloadSeries({ showId: this.show.id, scope, season, episode })
      .catch((err) => {
        console.warn('Series download failed:', err);
        this._setNotice(String((err && err.message) || err));
      });
  }

  /** Bandeau d'information sous la liste (recherche, échec, aucune source). */
  _setNotice(text) {
    this.noticeEl.textContent = text || '';
    this.root.classList.toggle('has-notice', !!text);
  }

  _startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.isOpen) this._loadSeason();
    }, POLL_MS);
  }

  _stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

/** Libellé de phase pour un épisode en cours (téléchargement / conversion). */
function phaseLabel(phase, pct) {
  if (phase === 'transcoding') return `Converting ${pct}%`;
  if (phase === 'downloading') return `Downloading ${pct}%`;
  if (phase === 'fetching-subs') return 'Subtitles…';
  return 'Queued…';
}

/** hh:mm:ss (ou mm:ss) — même format que le volet d'info des films. */
function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${pad(h)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default SeriesPopup;
