/**
 * Movie Browser
 * Overlay bibliothèque : liste (gauche) + volet détail (droite), pilotés au
 * curseur. Look décodeur rétro (en-tête + pied de page). Pensé pour une petite
 * TV basse résolution → texte et cibles volontairement grands.
 *
 * Émet :
 *   'play'         (entry)  quand PLAY est cliqué (film prêt)
 *   'delete'       (entry)  quand DELETE est confirmé (2 clics)
 *   'nav-library' / 'nav-search'  raccourcis de pied de page (via CrtFooter)
 */

import { EventEmitter } from './EventEmitter.js';
import { footerHtml, wireFooterNav } from './CrtFooter.js';
import { reveal } from './RetroFx.js';

// Modes de tri de la bibliothèque (cyclés par le bouton du pied de page).
const SORTS = [
  { key: 'default', label: 'Default' },
  { key: 'title', label: 'A → Z' },
  { key: 'recent', label: 'Recent' },
  { key: 'year', label: 'Year' },
  { key: 'progress', label: 'Progress' },
];

// Filtre basé sur l'état vu/pas-vu (% de complétion).
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unseen', label: 'Unseen' },
  { key: 'seen', label: 'Seen' },
];

// Filtre actif à l'ouverture : « Unseen » (on cache les films déjà terminés).
const DEFAULT_FILTER = FILTERS.findIndex((f) => f.key === 'unseen');

export class MovieBrowser extends EventEmitter {
  constructor(library) {
    super();
    this.library = library;
    this.root = null;
    this.listEl = null;
    this.detailEl = null;
    this.isOpen = false;
    this.selectedId = null;
    this._pendingDelete = false;
    this.sortIndex = 0;
    this.filterIndex = DEFAULT_FILTER;
    this.tab = 'movies'; // onglet actif : 'movies' | 'series'
    this._lastJobIds = '';
    this.disk = null;    // { freeBytes, totalBytes } — en-tête (espace restant)

    // L'espace libre bouge à chaque téléchargement ou suppression : on le
    // rafraîchit à chaque rechargement du catalogue plutôt qu'en boucle.
    this.library.on('loaded', () => this._refreshDisk());
  }

  /** Construit la structure DOM une seule fois et l'attache au body. */
  init() {
    const root = document.createElement('div');
    root.id = 'movie-browser';
    root.innerHTML = `
      <div class="crt-header">
        <span class="crt-title">Library</span>
        <span class="crt-meta"></span>
        <span class="crt-clock-wrap"><span class="crt-clock"></span><span class="crt-weather"></span><span class="crt-date"></span></span>
      </div>
      <div class="mb-body">
        <div class="mb-left">
          <div class="mb-tabs"></div>
          <div class="mb-list"></div>
        </div>
        <div class="mb-detail is-empty"></div>
      </div>
      <div class="mb-empty">No movies yet. Use « Search » to download one.</div>
      ${footerHtml(
        '<button class="crt-navbtn mb-filter" type="button"></button>' +
        '<button class="crt-navbtn mb-sort" type="button"></button>'
      )}
    `;
    document.body.appendChild(root);

    this.root = root;
    this.listEl = root.querySelector('.mb-list');
    this.detailEl = root.querySelector('.mb-detail');
    this.tabsEl = root.querySelector('.mb-tabs');
    this.metaEl = root.querySelector('.crt-meta');
    this.emptyMsg = root.querySelector('.mb-empty');
    this.sortBtn = root.querySelector('.mb-sort');
    this.filterBtn = root.querySelector('.mb-filter');

    // Onglets Movies / Series (délégation).
    this.tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn || btn.dataset.tab === this.tab) return;
      this.tab = btn.dataset.tab;
      this.selectedId = null;
      this.render();
    });

    wireFooterNav(root, this);
    // Boutons de tri / filtre (droite) : cyclent les modes et re-rendent.
    this.sortBtn.addEventListener('click', () => {
      this.sortIndex = (this.sortIndex + 1) % SORTS.length;
      this.render();
    });
    this.filterBtn.addEventListener('click', () => {
      this.filterIndex = (this.filterIndex + 1) % FILTERS.length;
      this.render();
    });
    this._updateFooterLabels();

    return this;
  }

  _updateFooterLabels() {
    this.sortBtn.textContent = `[Sort: ${SORTS[this.sortIndex].label}]`;
    // Sans le préfixe « Show: » : les valeurs se suffisent, et le pied de page
    // n'a plus la place depuis l'ajout du 3ᵉ raccourci [Advisor].
    this.filterBtn.textContent = `[${FILTERS[this.filterIndex].label}]`;
  }

  /** Affiche l'overlay et (re)construit la liste depuis le catalogue courant. */
  async open() {
    await this.library.load(); // → 'loaded' → _refreshDisk()
    this.render();
    this.isOpen = true;
    this.root.classList.add('open');
  }

  close() {
    this.isOpen = false;
    this._pendingDelete = false;
    this.root.classList.remove('open');
  }

  toggle() {
    return this.isOpen ? this.close() : this.open();
  }

  /**
   * Espace disque restant, affiché au centre de l'en-tête : c'est ce qui décide
   * si l'on peut encore télécharger, bien plus utile que le nombre d'éléments.
   */
  _refreshDisk() {
    this.library.apiClient.diskInfo()
      .then((d) => { this.disk = d; this._renderDisk(); })
      .catch(() => {}); // pas d'info disque → en-tête vide, rien de bloquant
  }

  _renderDisk() {
    const free = this.disk && this.disk.freeBytes;
    this.metaEl.textContent = free ? `${(free / 1e9).toFixed(1)} GB free` : '';
  }

  /** Barre d'onglets Movies/Series — affichée seulement si les DEUX existent. */
  _renderTabs() {
    const hasMovies = this.library.items().length > 0;
    const hasSeries = this.library.series().length > 0;
    if (!(hasMovies && hasSeries)) {
      this.tabsEl.style.display = 'none';
      this.tab = hasSeries && !hasMovies ? 'series' : 'movies';
      return;
    }
    this.tabsEl.style.display = '';
    const tab = (key, label) =>
      `<button class="mb-tab${this.tab === key ? ' is-active' : ''}" data-tab="${key}" type="button">${label}</button>`;
    this.tabsEl.innerHTML = tab('movies', 'Movies') + tab('series', 'Series');
  }

  /** Rendu de la liste + volet détail à partir des éléments filtrés/triés. */
  render() {
    this._renderTabs();
    const items = this._visibleItems();
    this._updateFooterLabels();
    this.listEl.innerHTML = '';
    this._renderDisk();
    this.emptyMsg.style.display = items.length ? 'none' : 'block';

    for (const entry of items) {
      this.listEl.appendChild(this.renderRow(entry));
    }

    // Conserve la sélection si toujours présente, sinon prend le premier élément.
    const stillThere = items.some((e) => e.id === this.selectedId);
    const target = stillThere ? this.selectedId : (items[0] ? items[0].id : null);
    this.select(target);
  }

  /** Éléments visibles selon l'onglet, après filtre (vu/pas-vu) puis tri. */
  _visibleItems() {
    // Onglet Series : liste des séries, le filtre vu/pas-vu ne s'applique pas.
    if (this.tab === 'series') {
      const series = this.library.series();
      const mode = SORTS[this.sortIndex].key;
      if (mode === 'title') {
        return series.slice().sort((a, b) =>
          (a.title || a.id).localeCompare(b.title || b.id, 'en', { sensitivity: 'base' }));
      }
      if (mode === 'year') return series.slice().sort((a, b) => (b.year || 0) - (a.year || 0));
      return series; // default/recent : déjà par ajout décroissant
    }

    let items = this.library.items(); // ordre par défaut (rang en cours/vus)

    // Filtre vu / pas-vu / tous (basé sur le % de complétion).
    const filter = FILTERS[this.filterIndex].key;
    if (filter === 'seen') items = items.filter((e) => this.library.isWatched(e));
    else if (filter === 'unseen') items = items.filter((e) => !this.library.isWatched(e));

    const mode = SORTS[this.sortIndex].key;
    if (mode === 'title') {
      return items.slice().sort((a, b) =>
        (a.title || a.id).localeCompare(b.title || b.id, 'en', { sensitivity: 'base' }));
    }
    if (mode === 'recent') {
      return items.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    }
    if (mode === 'year') {
      return items.slice().sort((a, b) => (b.year || 0) - (a.year || 0));
    }
    if (mode === 'progress') {
      return items.slice().sort((a, b) =>
        this.library.progressRatio(b) - this.library.progressRatio(a));
    }
    return items;
  }

  /** Une ligne : caret · titre · barre de progression (film prêt) ou état (en cours). */
  renderRow(entry) {
    if (entry.type === 'series') return this.renderSeriesRow(entry);
    const ready = this.library.isReady(entry);
    const busy = this.library.isActive(entry);
    const errored = entry.status === 'error';

    const row = document.createElement('div');
    row.className = 'mb-row' + (busy ? ' is-busy' : '') + (errored ? ' is-error' : '');
    row.dataset.movieId = entry.id;

    // Film prêt → barre de progression ; sinon → libellé d'état (téléchargement…).
    const lastCell = ready
      ? barHtml(this.library.progressRatio(entry))
      : `<span class="mb-row-status">${escapeHtml(statusInfo(entry).label)}</span>`;

    row.innerHTML = `
      <span class="mb-row-main"><span class="mb-caret">&gt;</span><span class="mb-row-title">${escapeHtml(entry.title || entry.id)}</span></span>
      ${lastCell}
    `;

    row.addEventListener('click', () => this.select(entry.id));
    return row;
  }

  /** Ligne série : titre + compteur d'épisodes obtenus / total. */
  renderSeriesRow(entry) {
    const owned = this.library.showOwnedCount(entry.id);
    const total = this.library.showTotalEpisodes(entry);
    const row = document.createElement('div');
    row.className = 'mb-row mb-row-series';
    row.dataset.movieId = entry.id;
    row.innerHTML = `
      <span class="mb-row-main"><span class="mb-caret">&gt;</span><span class="mb-row-title">${escapeHtml(entry.title || entry.id)}</span></span>
      <span class="mb-row-status mb-row-count">${owned}/${total} ep.</span>
    `;
    row.addEventListener('click', () => this.select(entry.id));
    return row;
  }

  /** Sélectionne un film : surligne la ligne et remplit le volet détail. */
  select(id) {
    const changed = id !== this.selectedId;
    this.selectedId = id;
    this._pendingDelete = false;
    for (const row of this.listEl.querySelectorAll('.mb-row')) {
      row.classList.toggle('is-active', row.dataset.movieId === id);
    }
    const entry = id ? this.library.get(id) : null;
    this.renderDetail(entry);
    // UNIQUEMENT sur un vrai changement de sélection : remonter le volet en haut
    // + cascade rétro. Les rafraîchissements de statut (/movies/status, chaque
    // seconde) re-render via renderDetail() sans passer par select() → ni scroll
    // ni animation parasites (on garde la position de lecture de la description).
    if (changed && entry) {
      this.detailEl.scrollTop = 0;
      reveal(this.detailEl, { selector: '.mb-detail > *' });
    }
  }

  /** Remplit le volet détail (affiche, titre/année, progression, PLAY/DELETE). */
  renderDetail(entry) {
    if (!entry) {
      this.detailEl.classList.add('is-empty');
      this.detailEl.innerHTML = 'Select a movie';
      return;
    }
    this.detailEl.classList.remove('is-empty');
    if (entry.type === 'series') return this.renderSeriesDetail(entry);

    const ready = this.library.isReady(entry);
    const ratio = ready ? this.library.progressRatio(entry) : statusInfo(entry).ratio;
    // Prêt → « temps courant / durée » ; sinon → libellé d'état.
    const progLine = ready
      ? (entry.duration ? `${formatTime(entry.currentTime || 0)} / ${formatTime(entry.duration)}` : '')
      : statusInfo(entry).label;

    this.detailEl.innerHTML = `
      <div class="mb-poster"><img draggable="false" alt="" /></div>
      <div class="mb-d-title">${escapeHtml(entry.title || entry.id)}</div>
      ${entry.year ? `<div class="mb-d-year">${escapeHtml(String(entry.year))}</div>` : ''}
      <div class="mb-d-prog">${escapeHtml(progLine)}
        ${barHtml(ratio, ready ? '' : barVariant(entry))}
      </div>
      <div class="mb-d-actions">
        <button class="crt-btn mb-play" type="button"${ready ? '' : ' disabled'}>Play</button>
        <button class="crt-btn mb-delete" type="button">Delete</button>
      </div>
      ${entry.overview ? `<div class="mb-d-overview">${escapeHtml(entry.overview)}</div>` : ''}
    `;
    const posterBox = this.detailEl.querySelector('.mb-poster');
    const img = posterBox.querySelector('img');
    img.addEventListener('error', () => posterBox.classList.add('no-poster'));
    img.src = this.posterUrl(entry);

    const playBtn = this.detailEl.querySelector('.mb-play');
    if (ready) playBtn.addEventListener('click', () => this.emit('play', entry));

    const delBtn = this.detailEl.querySelector('.mb-delete');
    delBtn.addEventListener('click', () => this._onDelete(delBtn, entry));
  }

  /** Volet détail d'une série : affiche, compteur, [Resume]/[Episodes]/[Delete]. */
  renderSeriesDetail(entry) {
    const owned = this.library.showOwnedCount(entry.id);
    const total = this.library.showTotalEpisodes(entry);
    const airing = entry.tmdbStatus === 'Returning Series' || entry.tmdbStatus === 'In Production';
    // Reprise : dernier épisode lancé (reprend à son currentTime).
    const last = this.library.lastPlayedEpisode(entry.id);
    const pad = (n) => String(n).padStart(2, '0');
    const resumeBtn = last
      ? `<button class="crt-btn mb-resume" type="button">▶ Resume S${pad(last.season)}E${pad(last.episode)}</button>`
      : '';

    this.detailEl.innerHTML = `
      <div class="mb-poster"><img draggable="false" alt="" /></div>
      <div class="mb-d-title">${escapeHtml(entry.title || entry.id)}</div>
      ${entry.year ? `<div class="mb-d-year">${escapeHtml(String(entry.year))}${airing ? ' · ongoing' : ''}</div>` : ''}
      <div class="mb-d-prog">${owned}/${total} episodes
        ${barHtml(total ? owned / total : 0)}
      </div>
      <div class="mb-d-actions">
        ${resumeBtn}
        <button class="crt-btn mb-episodes" type="button">Episodes</button>
        <button class="crt-btn mb-delete" type="button">Delete</button>
      </div>
      ${entry.overview ? `<div class="mb-d-overview">${escapeHtml(entry.overview)}</div>` : ''}
    `;
    const posterBox = this.detailEl.querySelector('.mb-poster');
    const img = posterBox.querySelector('img');
    img.addEventListener('error', () => posterBox.classList.add('no-poster'));
    img.src = this.posterUrl(entry);

    if (last) {
      this.detailEl.querySelector('.mb-resume').addEventListener('click', () =>
        this.emit('play-episode', { showId: entry.id, season: last.season, episode: last.episode }));
    }
    this.detailEl.querySelector('.mb-episodes')
      .addEventListener('click', () => this.emit('open-series', entry));
    const delBtn = this.detailEl.querySelector('.mb-delete');
    delBtn.addEventListener('click', () => this._onDelete(delBtn, entry));
  }

  /** Suppression à double confirmation (kiosque : pas de window.confirm). */
  _onDelete(btn, entry) {
    if (!this._pendingDelete) {
      this._pendingDelete = true;
      btn.textContent = 'Confirm?';
      btn.classList.add('is-active');
      return;
    }
    this._pendingDelete = false;
    this.emit('delete', entry);
  }

  /**
   * Mise à jour en place depuis un snapshot /movies/status (sans re-render).
   * Si l'ensemble des jobs actifs a changé, on recharge tout pour faire
   * apparaître/retirer les bonnes lignes.
   */
  syncActive(jobs) {
    // Recharge complète UNIQUEMENT quand l'ensemble des jobs change (début/fin) —
    // pas à chaque tick. Couvre aussi les jobs série (pack/épisode) dont la fin
    // met à jour les compteurs de l'onglet Series.
    const ids = Object.keys(jobs).sort().join(',');
    if (ids !== this._lastJobIds) {
      this._lastJobIds = ids;
      if (this.isOpen) this.open(); // recharge le catalogue + re-render
      return;
    }
    // Sinon : progression en place des lignes films en cours.
    for (const id of Object.keys(jobs)) {
      const row = this.listEl.querySelector(`.mb-row[data-movie-id="${id}"]`);
      if (row) this._applyRowStatus(row, { ...jobs[id], id });
    }
    // Rafraîchit le détail si le film sélectionné est en cours.
    if (this.selectedId && jobs[this.selectedId]) {
      this.renderDetail({ ...this.library.get(this.selectedId), ...jobs[this.selectedId] });
    }
  }

  _applyRowStatus(row, entry) {
    const status = row.querySelector('.mb-row-status');
    if (status) status.textContent = statusInfo(entry).label;
  }

  posterUrl(entry) {
    return `${this.library.apiClient.baseUrl}/poster/${encodeURIComponent(entry.id)}`;
  }
}

/**
 * Libellé + ratio de progression pour une entrée non prête.
 * Fonctionne pour une entrée de bibliothèque comme pour un snapshot de
 * /movies/status (mêmes champs status/progress).
 */
function statusInfo(entry) {
  const p = entry.progress || {};
  switch (entry.status) {
    case 'queued':
      return { label: 'Queued…', ratio: 0 };
    case 'downloading':
      return { label: `DL ${Math.round((p.download || 0) * 100)}%`, ratio: p.download || 0 };
    case 'fetching-subs':
      return { label: 'Subtitles…', ratio: 1 };
    case 'transcoding':
      return { label: `Conv. ${Math.round((p.transcode || 0) * 100)}%`, ratio: p.transcode || 0 };
    case 'error':
      return { label: `Error: ${entry.error || ''}`, ratio: 0 };
    default:
      return { label: '', ratio: 0 };
  }
}

/** 90000 → "01:30:00" ; 2820 → "47:00". */
function formatTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/**
 * Barre de progression simple : piste bleu foncé + remplissage ambre, réutilise
 * les classes partagées .crt-bar / .crt-bar-fill (mêmes que le seekbar de pause).
 */
function barHtml(ratio, variant = '') {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  const cls = variant ? ` mb-bar--${variant}` : '';
  return `<span class="crt-bar mb-bar${cls}"><span class="crt-bar-fill" style="width:${pct}%"></span></span>`;
}

/** Variante de couleur de la barre selon l'état (téléchargement / conversion). */
function barVariant(entry) {
  if (entry.status === 'downloading') return 'download';
  if (entry.status === 'transcoding' || entry.status === 'fetching-subs') return 'convert';
  return '';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default MovieBrowser;
