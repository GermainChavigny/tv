/**
 * Series Popup
 * Popup de gestion d'une série : onglets de saisons, grille d'épisodes avec leur
 * état (obtenu / en cours / manquant), et actions de téléchargement (épisode au
 * clic, saison entière, série entière). Un clic sur un épisode obtenu le lit.
 *
 * Émet :
 *   'download-series' ({showId, scope:'episode'|'season'|'series', season?, episode?})
 *   'play-episode'    ({showId, season, episode})
 *   'nav-*'           raccourcis de pied de page (via CrtFooter)
 */

import { EventEmitter } from './EventEmitter.js';
import { footerHtml, wireFooterNav } from './CrtFooter.js';
import { reveal } from './RetroFx.js';

const POLL_MS = 1500;

// Icône par état d'épisode (repli DejaVu couvre ces glyphes).
const STATE_ICON = { ready: '▶', downloading: '…', error: '!', missing: '+' };

export class SeriesPopup extends EventEmitter {
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.root = null;
    this.isOpen = false;
    this.show = null;
    this.season = null;
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
        <div class="sp-seasons"></div>
        <div class="sp-episodes"></div>
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

    wireFooterNav(root, this);
    root.querySelector('.sp-back').addEventListener('click', () => this.close());
    root.querySelector('.sp-dl-season').addEventListener('click', () => {
      if (this.season != null) this._download('season', this.season);
    });
    root.querySelector('.sp-dl-series').addEventListener('click', () => this._download('series'));

    // Onglet de saison.
    this.seasonsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-season]');
      if (btn) this._selectSeason(Number(btn.dataset.season));
    });

    // Clic sur un épisode : lire (obtenu) ou télécharger (manquant/erreur).
    this.episodesEl.addEventListener('click', (e) => {
      const row = e.target.closest('.sp-ep');
      if (!row) return;
      const ep = Number(row.dataset.ep);
      const state = row.dataset.state;
      if (state === 'ready') {
        this.emit('play-episode', { showId: this.show.id, season: this.season, episode: ep });
      } else if (state === 'missing' || state === 'error') {
        this._requested.add(`${this.season}x${ep}`);
        row.dataset.state = 'downloading';
        row.className = 'sp-ep sp-ep--downloading';
        row.querySelector('.sp-ep-state').textContent = STATE_ICON.downloading;
        this._download('episode', this.season, ep);
      }
    });

    return this;
  }

  /** Ouvre la popup sur une série (entrée library type 'series'). */
  open(show) {
    this.show = show;
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
    this._renderEpisodes(view.episodes || []);
  }

  _renderEpisodes(eps) {
    const owned = eps.filter((e) => e.state === 'ready').length;
    this.metaEl.textContent = `Season ${this.season} · ${owned}/${eps.length}`;
    this.episodesEl.innerHTML = eps.map((e) => {
      // Épisode cliqué mais statut serveur pas encore rafraîchi → « downloading ».
      const state = (e.state === 'missing' && this._requested.has(`${this.season}x${e.ep}`))
        ? 'downloading' : e.state;
      return `
        <div class="sp-ep sp-ep--${state}" data-ep="${e.ep}" data-state="${state}">
          <span class="sp-ep-state">${STATE_ICON[state] || ''}</span>
          <span class="sp-ep-num">E${String(e.ep).padStart(2, '0')}</span>
          <span class="sp-ep-title">${escapeHtml(e.title || '')}</span>
        </div>`;
    }).join('') || '<div class="sp-msg">No episodes</div>';
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
