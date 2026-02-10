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
        throw new Error(`API error: ${response.status} ${response.statusText}`);
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
   * Load movie progress from server
   */
  async loadMovieProgress() {
    return this.request(this.endpoints.moviesProgress);
  }

  /**
   * Save movie progress to server
   */
  async saveMovieProgress(data) {
    return this.request(this.endpoints.moviesProgress, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Get list of available movies
   */
  async loadMoviesList() {
    return this.request(this.endpoints.moviesList);
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
