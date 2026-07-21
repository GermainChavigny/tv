/**
 * Movie Downloader
 * Orchestre la recherche (clavier virtuel) → résultats (affiches) → lancement
 * du téléchargement → suivi de progression. Tout au curseur souris.
 *
 * Émet :
 *   'started' (id)     un téléchargement a démarré
 *   'ready'   (id)     un film est devenu jouable (rafraîchir la bibliothèque)
 */

import { EventEmitter } from './EventEmitter.js';
import { footerHtml, wireFooterNav } from './CrtFooter.js';

const POLL_MS = 1500;

// Modes de tri des résultats (cyclés par le bouton du pied de page).
const SORTS = [
  { key: 'seeders', label: 'Seeders' },
  { key: 'size', label: 'Size' },
  { key: 'title', label: 'A → Z' },
  { key: 'relevance', label: 'Relevance' },
];

/** "2.1 GB" / "756 MB" → octets (pour trier). */
function sizeToBytes(str) {
  const m = String(str || '').match(/([\d.]+)\s*(gb|mb|kb|tb)/i);
  if (!m) return 0;
  const units = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return parseFloat(m[1]) * (units[m[2].toLowerCase()] || 1);
}

export class MovieDownloader extends EventEmitter {
  constructor(apiClient, voiceAnnouncer) {
    super();
    this.apiClient = apiClient;
    this.voice = voiceAnnouncer;
    this.root = null;
    this.pollTimer = null;
    this.knownJobs = {}; // id -> status, pour détecter les transitions
    // Jobs supprimés par l'utilisateur : leur disparition NE doit pas déclencher
    // l'annonce « Film prêt » (une suppression n'est pas une fin de conversion).
    this.ignoredJobs = new Set();
    this.lastResults = [];
    this.sortIndex = 0;
    this.mode = 'movie';   // 'movie' | 'series'
    this.lastQuery = '';
  }

  init() {
    const root = document.createElement('div');
    root.id = 'movie-search';
    root.innerHTML = `
      <div class="crt-header">
        <span class="crt-title">Search Results</span>
        <span class="crt-meta"></span>
        <span class="crt-clock-wrap"><span class="crt-clock"></span><span class="crt-weather"></span><span class="crt-date"></span></span>
      </div>
      <div class="ms-message"></div>
      <div class="ms-body">
        <div class="ms-list"></div>
        <div class="ms-detail is-empty"></div>
      </div>
      ${footerHtml(
        '<button class="crt-navbtn ms-mode" type="button"></button>' +
        '<button class="crt-navbtn ms-sort" type="button"></button>'
      )}
    `;
    document.body.appendChild(root);
    this.root = root;
    this.listEl = root.querySelector('.ms-list');
    this.detailEl = root.querySelector('.ms-detail');
    this.bodyEl = root.querySelector('.ms-body');
    this.messageEl = root.querySelector('.ms-message');
    this.metaEl = root.querySelector('.crt-meta');
    this.sortBtn = root.querySelector('.ms-sort');
    this.modeBtn = root.querySelector('.ms-mode');
    this.selectedIdx = 0;
    this._shown = [];

    wireFooterNav(root, this);
    this.sortBtn.addEventListener('click', () => {
      this.sortIndex = (this.sortIndex + 1) % SORTS.length;
      this.renderResults();
    });
    // Bascule Film/Série : relance la même requête dans l'autre mode.
    this.modeBtn.addEventListener('click', () => {
      this.mode = this.mode === 'series' ? 'movie' : 'series';
      if (this.lastQuery) this.search(this.lastQuery, this.mode);
      else this._updateFooterLabels();
    });
    this._updateFooterLabels();
    return this;
  }

  _updateFooterLabels() {
    this.sortBtn.textContent = `[Sort: ${SORTS[this.sortIndex].label}]`;
    this.modeBtn.textContent = this.mode === 'series' ? '[Series]' : '[Movies]';
  }

  open() {
    this.isOpen = true;
    this.root.classList.add('open');
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  /**
   * Lance une recherche (film ou série) et affiche les résultats.
   * @param {string} query
   * @param {'movie'|'series'} [mode]  bascule Film/Série (défaut : mode courant).
   */
  async search(query, mode) {
    if (mode) this.mode = mode;
    this.lastQuery = query;
    this.open();
    this._updateFooterLabels();
    this.metaEl.textContent = '';
    this.bodyEl.style.display = 'none';
    this.messageEl.style.display = '';
    const kind = this.mode === 'series' ? 'series' : 'movie';
    this.messageEl.textContent = `Searching « ${query} » (${kind})…`;

    let results;
    try {
      results = this.mode === 'series'
        ? await this.apiClient.searchSeries(query)
        : await this.apiClient.searchMovies(query);
    } catch (err) {
      this.messageEl.textContent = 'Search error (indexer/TMDB unreachable?).';
      return;
    }

    if (!results || !results.length) {
      this.messageEl.textContent = `No results for « ${query} ».`;
      return;
    }
    // Conserve l'ordre d'origine (indexé) pour le tri « Relevance ».
    this.lastResults = results.map((m, i) => ({ ...m, _rank: i }));
    this.messageEl.style.display = 'none';
    this.bodyEl.style.display = 'flex';
    this.renderResults();
  }

  /** (Re)affiche la liste selon le tri courant + sélectionne le 1er résultat. */
  renderResults() {
    this._updateFooterLabels();
    this._shown = this._sortedResults();
    this.metaEl.textContent = `${this._shown.length} ${this._shown.length > 1 ? 'results' : 'result'}`;
    this.listEl.innerHTML = '';
    this._shown.forEach((movie, idx) => this.listEl.appendChild(this.renderRow(movie, idx)));
    this.select(0);
  }

  _sortedResults() {
    // En mode série, pas de torrents : on garde l'ordre TMDB (pertinence).
    if (this.mode === 'series') return this.lastResults.slice();
    const mode = SORTS[this.sortIndex].key;
    const best = (m) => (m.torrents && m.torrents[0]) || {};
    const arr = this.lastResults.slice();
    if (mode === 'seeders') arr.sort((a, b) => (best(b).seeders || 0) - (best(a).seeders || 0));
    else if (mode === 'size') arr.sort((a, b) => sizeToBytes(best(b).size) - sizeToBytes(best(a).size));
    else if (mode === 'title') arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'en', { sensitivity: 'base' }));
    else arr.sort((a, b) => a._rank - b._rank); // relevance : ordre d'origine
    return arr;
  }

  /** Une ligne de résultat : titre + sous-ligne (année · taille · seeders). */
  renderRow(movie, idx) {
    const row = document.createElement('div');
    row.className = 'ms-row';
    row.dataset.idx = idx;

    let sub;
    if (this.mode === 'series') {
      sub = movie.year ? String(movie.year) : '';
    } else {
      const best = (movie.torrents && movie.torrents[0]) || {};
      sub = [
        movie.year || null,
        best.size != null ? best.size : null,
        best.seeders != null ? `${best.seeders} seeders` : null,
      ].filter(Boolean).map(escapeHtml).join(' · ');
    }

    row.innerHTML = `
      <div class="ms-r-title">${escapeHtml(movie.title)}</div>
      ${sub ? `<div class="ms-r-sub">${escapeHtml(sub)}</div>` : ''}
    `;
    row.addEventListener('click', () => this.select(idx));
    return row;
  }

  /** Sélectionne un résultat : surligne la ligne et remplit le volet détail. */
  select(idx) {
    this.selectedIdx = idx;
    for (const row of this.listEl.querySelectorAll('.ms-row')) {
      row.classList.toggle('is-active', Number(row.dataset.idx) === idx);
    }
    this.renderDetail(this._shown[idx]);
  }

  /** Volet détail : affiche + toutes les infos + bouton Download. */
  renderDetail(movie) {
    if (!movie) {
      this.detailEl.classList.add('is-empty');
      this.detailEl.innerHTML = 'Select a result';
      return;
    }
    this.detailEl.classList.remove('is-empty');
    const isSeries = this.mode === 'series';
    const best = (movie.torrents && movie.torrents[0]) || {};
    const specs = isSeries ? '' : [best.quality, best.size,
      best.seeders != null ? `${best.seeders} seeders` : null]
      .filter(Boolean).map(escapeHtml).join(' · ');

    this.detailEl.innerHTML = `
      <div class="ms-d-poster">${movie.posterUrl ? '<img draggable="false" alt="" />' : ''}</div>
      <div class="ms-d-title">${escapeHtml(movie.title)}</div>
      ${movie.year ? `<div class="ms-d-year">${escapeHtml(String(movie.year))}</div>` : ''}
      ${specs ? `<div class="ms-d-specs">${specs}</div>` : ''}
      <button class="crt-btn ${isSeries ? 'ms-add' : 'ms-dl'}" type="button">${isSeries ? 'Manage episodes' : 'Download'}</button>
      ${movie.overview ? `<div class="ms-d-overview">${escapeHtml(movie.overview)}</div>` : ''}
    `;

    if (movie.posterUrl) {
      const box = this.detailEl.querySelector('.ms-d-poster');
      const img = box.querySelector('img');
      img.addEventListener('error', () => box.classList.add('no-poster'));
      img.src = movie.posterUrl;
    }
    if (isSeries) {
      // Choisir une série → l'enregistrer + ouvrir la popup épisodes (app.js).
      this.detailEl.querySelector('.ms-add').addEventListener('click', () => this.emit('add-series', movie));
    } else {
      this.detailEl.querySelector('.ms-dl').addEventListener('click', () => this.download(movie, best));
    }
  }

  /**
   * Démarre le téléchargement du meilleur torrent d'un résultat.
   */
  async download(movie, torrent) {
    try {
      const res = await this.apiClient.downloadMovie({
        magnet: torrent.magnet,
        title: movie.title,
        year: movie.year,
        tmdbId: movie.tmdbId,
        imdbId: movie.imdbId,
        posterUrl: movie.posterUrl,
        overview: movie.overview,
      });
      if (res.error) {
        this.messageEl.textContent = res.error;
        return;
      }
      this.emit('started', res.id);
      this.close();
      this.startPolling();
    } catch (err) {
      this.messageEl.textContent = 'Could not start the download.';
    }
  }

  /**
   * Suit les jobs actifs ; annonce et signale les films devenus prêts.
   */
  startPolling() {
    if (this.pollTimer) return;
    const tick = async () => {
      let jobs;
      try {
        jobs = await this.apiClient.moviesStatus();
      } catch {
        return;
      }
      // Pilote l'affichage de progression dans la grille (tuiles).
      this.emit('tick', jobs);

      // Détecte les transitions -> ready (un job connu qui disparaît des actifs).
      // Un job supprimé par l'utilisateur disparaît de la même manière : on le
      // saute (pas d'annonce) via la liste des jobs ignorés.
      for (const id of Object.keys(this.knownJobs)) {
        if (jobs[id]) continue;
        if (this.ignoredJobs.has(id)) continue; // supprimé : pas de « Film prêt »
        this.emit('ready', id);
        // Pas d'annonce pour les jobs série (un pack = beaucoup d'épisodes).
        const prev = this.knownJobs[id];
        const isSeries = prev && (prev.type === 'episode' || prev.type === 'pack');
        if (this.voice && !isSeries) this.voice.announce('Film prêt', 0.8);
      }
      this.knownJobs = jobs;

      // Purge les ids ignorés qui ne sont plus actifs (supprimés/terminés) pour
      // ne pas accumuler. Ceux encore en cours restent marqués jusqu'à leur fin.
      for (const id of this.ignoredJobs) {
        if (!jobs[id]) this.ignoredJobs.delete(id);
      }

      if (!Object.keys(jobs).length) this.stopPolling();
    };
    tick();
    this.pollTimer = setInterval(tick, POLL_MS);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Marque un job comme supprimé par l'utilisateur : quand il disparaîtra des
   * jobs actifs, on n'annoncera pas « Film prêt ». Sûr même si la suppression
   * (asynchrone) prend plusieurs cycles de polling — l'id reste ignoré tant que
   * le job est encore listé.
   */
  ignoreJob(id) {
    this.ignoredJobs.add(id);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default MovieDownloader;
