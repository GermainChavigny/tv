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
        <span class="crt-meta sp-meta"></span>
        <span class="crt-clock-wrap"><span class="crt-clock"></span><span class="crt-weather"></span><span class="crt-date"></span></span>
      </div>
      <div class="sp-body">
        <div class="sp-left">
          <div class="sp-seasons"></div>
          <div class="sp-episodes"></div>
        </div>
        <div class="sp-detail is-empty"></div>
      </div>
      <div class="sp-actions">
        <button class="crt-btn sp-dl-season" type="button">Download season</button>
        <button class="crt-btn sp-dl-series" type="button">Download series</button>
      </div>
      ${footerHtml('<button class="crt-navbtn sp-back" type="button">[Back]</button>')}
    `;
    document.body.appendChild(root);

    this.root = root;
    this.titleEl = root.querySelector('.sp-title');
    this.metaEl = root.querySelector('.sp-meta');
    this.seasonsEl = root.querySelector('.sp-seasons');
    this.episodesEl = root.querySelector('.sp-episodes');
    this.detailEl = root.querySelector('.sp-detail');

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
  open(show) {
    this.show = show;
    this.selectedEp = null;
    this._requested.clear();
    this.titleEl.textContent = show.title || show.id;
    this._renderSeasons();
    const first = (show.seasons && show.seasons[0]) ? show.seasons[0].seasonNumber : 1;
    this._selectSeason(first);
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

  async _selectSeason(n) {
    this.season = n;
    this.selectedEp = null;
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
    const owned = eps.filter((e) => e.state === 'ready').length;
    this.metaEl.textContent = `Season ${this.season} · ${owned}/${eps.length}`;
    if (!eps.length) {
      this.episodesEl.innerHTML = '<div class="sp-msg">No episodes</div>';
      this._renderDetail(null);
      return;
    }
    this.episodesEl.innerHTML = eps.map((e) => {
      const st = this._effState(e);
      return `
        <div class="sp-ep sp-ep--${st}" data-ep="${e.ep}">
          <span class="sp-ep-state">${(STATE[st] || {}).icon || ''}</span>
          <span class="sp-ep-num">E${String(e.ep).padStart(2, '0')}</span>
          <span class="sp-ep-title">${escapeHtml(e.title || '')}</span>
        </div>`;
    }).join('');
    // Conserve la sélection si l'épisode existe encore, sinon prend le premier.
    const keep = eps.some((e) => e.ep === this.selectedEp);
    this._selectEpisode(keep ? this.selectedEp : eps[0].ep);
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
    const meta = STATE[st] || STATE.missing;
    const num = `S${String(this.season).padStart(2, '0')}E${String(e.ep).padStart(2, '0')}`;
    const action = st === 'ready'
      ? '<button class="crt-btn sp-play" type="button">▶ Play</button>'
      : st === 'downloading'
        ? '<button class="crt-btn" type="button" disabled>Downloading…</button>'
        : '<button class="crt-btn sp-get" type="button">Download episode</button>';

    this.detailEl.innerHTML = `
      <div class="sp-d-still">${e.still ? '<img draggable="false" alt="" />' : ''}</div>
      <div class="sp-d-num">${num}</div>
      <div class="sp-d-title">${escapeHtml(e.title || '')}</div>
      <div class="sp-d-state sp-d-state--${st}">${meta.icon} ${meta.label}</div>
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
    this.apiClient.downloadSeries({ showId: this.show.id, scope, season, episode })
      .catch((err) => console.warn('Series download failed:', err));
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

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default SeriesPopup;
