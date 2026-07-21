/**
 * Movie Library Model
 * Charge le catalogue depuis le backend et fournit un ordre de tri stable :
 *   1) téléchargements en attente / en cours
 *   2) films déjà lancés (le plus récemment lancé d'abord)
 *   3) films jamais lancés (le plus récemment téléchargé d'abord)
 */

import { EventEmitter } from './EventEmitter.js';
import { apiClient } from './ApiClient.js';

// Au-delà de cette fraction de la durée, un film est considéré comme "vu".
const WATCHED_THRESHOLD = 0.92;

export class MovieLibrary extends EventEmitter {
  constructor(client = apiClient) {
    super();
    this.apiClient = client;
    this.entries = {}; // { id: entry }
  }

  /**
   * (Re)charge le catalogue depuis /movies/library.
   */
  async load() {
    try {
      this.entries = (await this.apiClient.loadLibrary()) || {};
      this.emit('loaded', this.entries);
    } catch (err) {
      console.error('Failed to load movie library:', err);
      this.entries = {};
    }
    return this.entries;
  }

  get(id) {
    return this.entries[id] || null;
  }

  isWatched(entry) {
    if (entry.watched) return true;
    const { currentTime = 0, duration = 0 } = entry;
    return duration > 0 && currentTime >= WATCHED_THRESHOLD * duration;
  }

  /** Film en cours de téléchargement/conversion (pas encore jouable). */
  isActive(entry) {
    return ['queued', 'downloading', 'fetching-subs', 'transcoding'].includes(entry.status);
  }

  isReady(entry) {
    return entry.status === 'ready';
  }

  /**
   * Fraction lue (0..1) pour la barre de progression.
   */
  progressRatio(entry) {
    const { currentTime = 0, duration = 0 } = entry;
    if (!duration) return 0;
    return Math.max(0, Math.min(1, currentTime / duration));
  }

  /**
   * Un film a-t-il déjà été lancé au moins une fois ?
   * `lastPlayedAt` n'existe pas sur les entrées antérieures à son ajout : on
   * retombe alors sur la progression enregistrée.
   */
  hasBeenPlayed(entry) {
    return !!entry.lastPlayedAt || (entry.currentTime || 0) > 0;
  }

  /**
   * Films affichés dans la liste, triés :
   *   0) en attente / en cours de téléchargement (les plus récents d'abord)
   *   1) déjà lancés — le plus récemment lancé d'abord
   *   2) jamais lancés — le plus récemment téléchargé d'abord
   *   3) en erreur (en fin de liste)
   */
  items() {
    // FILMS uniquement : on exclut les séries, épisodes et jobs pack (gérés à part).
    const all = Object.values(this.entries)
      .filter((e) => e.status && (!e.type || e.type === 'movie'));

    const rank = (e) => {
      if (this.isActive(e)) return 0;
      if (e.status === 'error') return 3;
      return this.hasBeenPlayed(e) ? 1 : 2;
    };

    return all.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      // Déjà lancés : le plus récemment lancé d'abord (à défaut, le plus récemment ajouté).
      if (ra === 1) {
        return (b.lastPlayedAt || b.addedAt || 0) - (a.lastPlayedAt || a.addedAt || 0);
      }
      return (b.addedAt || 0) - (a.addedAt || 0); // sinon : le plus récent d'abord
    });
  }

  /** Séries du catalogue (type 'series'), les plus récemment ajoutées d'abord. */
  series() {
    return Object.values(this.entries)
      .filter((e) => e.type === 'series')
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  /** Épisodes (type 'episode') d'une série, groupés par saison et triés. */
  episodesBySeason(showId) {
    const by = {};
    for (const e of Object.values(this.entries)) {
      if (e.type === 'episode' && e.showId === showId) {
        (by[e.season] = by[e.season] || []).push(e);
      }
    }
    for (const s of Object.keys(by)) by[s].sort((a, b) => (a.episode || 0) - (b.episode || 0));
    return by;
  }

  /** Nombre total d'épisodes annoncés par TMDB (hors specials). */
  showTotalEpisodes(show) {
    return (show.seasons || []).reduce((n, s) => n + (s.episodeCount || 0), 0);
  }

  /** Nombre d'épisodes réellement disponibles (prêts) d'une série. */
  showOwnedCount(showId) {
    return Object.values(this.entries)
      .filter((e) => e.type === 'episode' && e.showId === showId && e.status === 'ready').length;
  }

  /** Dernier épisode LANCÉ d'une série (le plus récent lastPlayedAt), ou null. */
  lastPlayedEpisode(showId) {
    let best = null;
    for (const e of Object.values(this.entries)) {
      if (e.type === 'episode' && e.showId === showId && e.status === 'ready'
          && (e.lastPlayedAt || 0) > 0
          && (!best || e.lastPlayedAt > best.lastPlayedAt)) {
        best = e;
      }
    }
    return best;
  }
}

export default MovieLibrary;
