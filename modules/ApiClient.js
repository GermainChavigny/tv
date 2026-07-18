/**
 * API Client for backend communication
 */

import config from '../config.js';

export class ApiClient {
  constructor(baseUrl = null) {
    this.baseUrl = baseUrl || config.api.host;
    this.endpoints = config.api.endpoints;
  }

  /**
   * Make a fetch request with error handling
   */
  async request(endpoint, options = {}) {
    try {
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      });

      if (!response.ok) {
        // Le backend renvoie {"error": "..."} sur ses 4xx/5xx : remonter ce
        // message plutôt qu'un code nu, pour qu'un écran puisse l'afficher.
        const detail = await response.json().catch(() => null);
        throw new Error(
          (detail && detail.error) || `API error: ${response.status} ${response.statusText}`
        );
      }

      return await response.json();
    } catch (err) {
      console.error(`API request failed for ${endpoint}:`, err);
      throw err;
    }
  }

  /**
   * Load playlist progress from server
   */
  async loadPlaylistProgress() {
    return this.request(this.endpoints.load);
  }

  /**
   * Save playlist progress to server
   */
  async savePlaylistProgress(data) {
    return this.request(this.endpoints.save, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Load the full movie library (catalogue) from server
   */
  async loadLibrary() {
    return this.request(this.endpoints.library);
  }

  /**
   * Patch one library entry (playback progress, watched flag, ...)
   */
  async saveLibraryEntry(id, fields) {
    return this.request(this.endpoints.library, {
      method: 'POST',
      body: JSON.stringify({ id, fields }),
    });
  }

  /**
   * Search movies via the backend indexer(s) + TMDB
   */
  async searchMovies(query) {
    return this.request(this.endpoints.moviesSearch, {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  /**
   * Start a download/transcode job (magnet + metadata, or local file)
   */
  async downloadMovie(payload) {
    return this.request(this.endpoints.moviesDownload, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Poll active download/transcode jobs
   */
  async moviesStatus() {
    return this.request(this.endpoints.moviesStatus);
  }

  /**
   * Cancel a running/queued job
   */
  async cancelMovie(id) {
    return this.request(this.endpoints.moviesCancel, {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  }

  /**
   * Delete a movie from the library (entry + files)
   */
  async deleteMovie(id) {
    return this.request(this.endpoints.moviesDelete || '/movies/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  }

  /**
   * Ask the Movie Advisor for 3 recommendations matching the criteria.
   * The backend adds the exclusions (blacklist + owned movies) itself.
   * @param {object} criteria  { mood, pace, era, scale, rating, length, theme1, theme2 }
   * @param {string} [keywords]  free-text added to the prompt (actor, theme…)
   * @returns {Promise<Array<{id,title,year,posterUrl,summary}>>}
   */
  async adviseMovies(criteria, keywords = '') {
    return this.request(this.endpoints.advisorRecommend, {
      method: 'POST',
      body: JSON.stringify({ criteria, keywords }),
    });
  }

  /**
   * Blacklist a movie so the advisor never recommends it again (persisted).
   */
  async forgetMovie({ id, title, year }) {
    return this.request(this.endpoints.advisorForget, {
      method: 'POST',
      body: JSON.stringify({ id, title, year }),
    });
  }

  /**
   * Weather for the next hour (Tours), proxied by the backend from Open-Meteo.
   * @returns {Promise<{code:number, hour:string}>}
   */
  async getWeather() {
    return this.request(this.endpoints.weather);
  }

  /**
   * Build the URL of a movie poster (served by the backend)
   */
  posterUrl(id) {
    return `${this.baseUrl}${this.endpoints.poster}/${encodeURIComponent(id)}`;
  }

  /**
   * Build the URL of a subtitle track (WebVTT) for a given language
   */
  subtitleUrl(id, lang) {
    return `${this.baseUrl}${this.endpoints.subtitle}/${encodeURIComponent(id)}/${encodeURIComponent(lang)}`;
  }

  /**
   * Control TV power (through Flask proxy to Shelly)
   */
  async setTvPower(on) {
    try {
      const response = await this.request(this.endpoints.tvPower || '/tv-power', {
        method: 'POST',
        body: JSON.stringify({ on }),
      });
      console.log(`📡 TV Power: ${on ? 'ON' : 'OFF'}`, response);
      return response;
    } catch (err) {
      console.warn('TV power control error:', err);
      // Don't throw - TV control is not critical
      return { status: 'error', message: err.message };
    }
  }

  /**
   * Load alarm settings from server
   */
  async loadAlarmSettings() {
    try {
      return await this.request(this.endpoints.alarmSettings || '/alarm-settings');
    } catch (err) {
      console.warn('Could not load alarm settings:', err);
      return null;
    }
  }

  /**
   * Save alarm settings to server
   */
  async saveAlarmSettings(data) {
    return this.request(this.endpoints.alarmSettings || '/alarm-settings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
}

// Export singleton instance
export const apiClient = new ApiClient();
export default apiClient;
