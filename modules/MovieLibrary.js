/**
 * Movie Library Model
 * Charge le catalogue depuis le backend et fournit un ordre de tri stable :
 *   1) films en cours de visionnage (progression partielle)
 *   2) films non vus (les plus récemment ajoutés d'abord)
 *   3) films déjà vus (en fin de liste)
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

  /**
   * True si le film a une progression exploitable mais n'est pas terminé.
   */
  isInProgress(entry) {
    const { currentTime = 0, duration = 0, watched } = entry;
    if (watched) return false;
    return currentTime > 5 && (duration === 0 || currentTime < WATCHED_THRESHOLD * duration);
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
   * Films affichés dans la grille, triés :
   *   0) téléchargements/conversions en cours (les plus récents d'abord)
   *   1) en cours de visionnage
   *   2) non vus (les plus récents d'abord)
   *   3) déjà vus
   *   4) en erreur (en fin de liste)
   */
  items() {
    const all = Object.values(this.entries).filter((e) => e.status);

    const rank = (e) => {
      if (this.isActive(e)) return 0;
      if (e.status === 'error') return 4;
      if (this.isInProgress(e)) return 1;
      if (this.isWatched(e)) return 3;
      return 2; // non vu, prêt
    };

    return all.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1) return (b.currentTime || 0) - (a.currentTime || 0); // en cours de visionnage : plus avancé d'abord
      return (b.addedAt || 0) - (a.addedAt || 0); // sinon : plus récent d'abord
    });
  }
}

export default MovieLibrary;
