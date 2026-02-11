/**
 * Centralized state management
 * Single source of truth for all application state
 */

import { EventEmitter } from './EventEmitter.js';

class StateManager extends EventEmitter {
  constructor() {
    super();
    
    // Playlist and progress state
    this.playlistData = {}; // {playlistId: {videoId, videoIndex, currentTime}}
    this.movieData = {}; // {filename: {currentTime}}
    this.movies = []; // List of available movie files

    // Player state
    this.currentPlaylistId = null;
    this.currentMovieFile = null;
    this.isMovieMode = false;
    this.player = null; // YouTube player instance
    this.moviePlayer = null; // HTML5 video element

    // Alarm state (managed by AlarmManager)
    this.alarmTime = '08:00';
    this.alarmEnabled = false;

    // UI state
    this.brightness = 0; // Dark overlay opacity 0-1
    this.cursorVisible = true;
    this.channelsSelectorVisible = false;
    this.channelsSelectorTimeout = null;

    // Auto-save
    this.saveInterval = null;
    this.saveIntervalDuration = 2500; // ms

    // Playlists configuration
    this.playlists = [
      {id: 'PLy1pnOysMn9LkcL89omeqd79FH7K3zitw', logo: 'newsTV.png', name: 'News', noSave: true},
      {id: 'PLmNJItE2MCubz0ibr5tB07Hp4NCZWztWL', logo: 'dunkTV.png', name: 'Basketball'},
      {id: 'PLI-KORiB_eLzez0JL6CR_XadP-Nm8XfJA', logo: 'DisneyTV.png', name: 'Disney'},
      {id: 'PL0dRZjWdHde0R7UQLzNo64bHaFtvmw4wC', logo: 'Making of TV.png', name: 'Making Of'},
      {id: 'PLg6bQuWdqr_YpnEkOrJdh3ZVSiY6suben', logo: 'BTV.png', name: 'Billiard'},
      {id: 'PL9qa1Jiw7oNLToYdTLlVpabi_wXpiTpq8', logo: 'sumoTV.png', name: 'Sumo'},
      {id: 'PLy1pnOysMn9JrrVsp1kk6RHK_UHxQKAJi', logo: 'WakeUpTV.png', name: 'Wake Up', isAlarm: true},
      {id: 'PLy1pnOysMn9JVLeoL1QrV4aSEdujD4ESV', logo: 'SleepTV.jpg', name: 'Sleep'},
      {id: 'movies', logo: 'MovieTV.png', name: 'Movies', isMovieMode: true},
    ];
  }

  // ============ PLAYLIST DATA ============

  setPlaylistData(playlistId, data) {
    this.playlistData[playlistId] = data;
    this.emit('playlistDataChanged', { playlistId, data });
  }

  getPlaylistData(playlistId) {
    return this.playlistData[playlistId] || { videoId: '', videoIndex: 0, currentTime: 0 };
  }

  // ============ MOVIE DATA ============

  setMovieData(filename, data) {
    this.movieData[filename] = data;
    this.emit('movieDataChanged', { filename, data });
  }

  getMovieData(filename) {
    return this.movieData[filename] || { currentTime: 0 };
  }

  setMovies(movies) {
    this.movies = movies;
    this.emit('moviesListChanged', movies);
  }

  // ============ PLAYER STATE ============

  setCurrentPlaylist(playlistId) {
    this.currentPlaylistId = playlistId;
    this.emit('currentPlaylistChanged', playlistId);
  }

  setCurrentMovie(filename) {
    this.currentMovieFile = filename;
    this.emit('currentMovieChanged', filename);
  }

  switchToMovieMode(enable = true) {
    this.isMovieMode = enable;
    this.emit('movieModeChanged', enable);
  }

  setPlayerInstance(player) {
    this.player = player;
  }

  setMoviePlayerElement(element) {
    this.moviePlayer = element;
  }

  // ============ ALARM STATE ============

  setAlarmTime(time) {
    this.alarmTime = time;
    this.emit('alarmTimeChanged', time);
  }

  setAlarmEnabled(enabled) {
    this.alarmEnabled = enabled;
    this.emit('alarmEnabledChanged', enabled);
  }

  // ============ UI STATE ============

  setBrightness(opacity) {
    this.brightness = Math.max(0, Math.min(1, opacity));
    this.emit('brightnessChanged', this.brightness);
  }

  increaseBrightness() {
    // Finer granularity when very dark (brightness close to 1) for precise control
    let step = 0.05; // Default step
    if (this.brightness > 0.8) {
      step = 0.01; // Very fine control when very dark
    } else if (this.brightness > 0.5) {
      step = 0.02; // Fine control in dark-to-medium zones
    }
    this.setBrightness(this.brightness + step);
  }

  decreaseBrightness() {
    // Finer granularity when very dark (brightness close to 1) for precise control
    let step = 0.05; // Default step
    if (this.brightness > 0.8) {
      step = 0.01; // Very fine control when very dark
    } else if (this.brightness > 0.5) {
      step = 0.02; // Fine control in dark-to-medium zones
    }
    this.setBrightness(this.brightness - step);
  }

  setCursorVisible(visible) {
    this.cursorVisible = visible;
    this.emit('cursorVisibilityChanged', visible);
  }

  setChannelsSelectorVisible(visible) {
    this.channelsSelectorVisible = visible;
    this.emit('channelsSelectorVisibilityChanged', visible);
  }

  // ============ AUTO-SAVE ============

  startAutoSave(callback) {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }
    this.saveInterval = setInterval(callback, this.saveIntervalDuration);
  }

  stopAutoSave() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }

  // ============ UTILITIES ============

  /**
   * Load all data from server
   */
  async loadAllData(apiClient) {
    try {
      const playlistData = await apiClient.loadPlaylistProgress();
      const movieData = await apiClient.loadMovieProgress();
      const movies = await apiClient.loadMoviesList();

      this.playlistData = playlistData || {};
      this.movieData = movieData || {};
      this.movies = movies || [];

      this.emit('dataLoaded', { playlistData, movieData, movies });
      return true;
    } catch (err) {
      console.error('Error loading data:', err);
      this.emit('dataLoadError', err);
      return false;
    }
  }

  /**
   * Reset to default state
   */
  reset() {
    this.playlistData = {};
    this.movieData = {};
    this.movies = [];
    this.currentPlaylistId = null;
    this.currentMovieFile = null;
    this.isMovieMode = false;
    this.brightness = 0;
    this.stopAutoSave();
    this.emit('stateReset');
  }

  /**
   * Export state for debugging
   */
  getState() {
    return {
      playlistData: { ...this.playlistData },
      movieData: { ...this.movieData },
      movies: [...this.movies],
      currentPlaylistId: this.currentPlaylistId,
      currentMovieFile: this.currentMovieFile,
      isMovieMode: this.isMovieMode,
      alarmTime: this.alarmTime,
      alarmEnabled: this.alarmEnabled,
      brightness: this.brightness,
      playlists: this.playlists,
    };
  }
}

// Export singleton instance
export const state = new StateManager();
export default state;
