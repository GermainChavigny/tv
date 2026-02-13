/**
 * Player Manager Module
 * Manages switching between YouTube and Movie players
 */

import { EventEmitter } from './EventEmitter.js';

export class PlayerManager extends EventEmitter {
  constructor(state, apiClient) {
    super();
    this.state = state;
    this.apiClient = apiClient;
    this.youtubePlayer = null;
    this.moviePlayer = null;
    this.movieContainer = null;
    this.currentVideoId = null; // Track current video to detect changes
  }

  /**
   * Initialize YouTube player
   */
  initYouTubePlayer(player) {
    this.youtubePlayer = player;
    this.state.setPlayerInstance(player);
    console.log('YouTube player initialized');
  }

  /**
   * Initialize movie player
   */
  initMoviePlayer(moviePlayerElement, movieContainerElement) {
    this.moviePlayer = moviePlayerElement;
    this.movieContainer = movieContainerElement;
    this.state.setMoviePlayerElement(moviePlayerElement);
    console.log('Movie player initialized');
  }

  /**
   * Play YouTube playlist
   */
  playPlaylist(index) {
    if (index < 0 || index >= this.state.playlists.length) {
      console.warn(`Invalid playlist index: ${index}`);
      return;
    }

    const playlist = this.state.playlists[index];

    console.log(`Playing playlist ${index}: ${playlist.name}`);

    this.state.setCurrentPlaylist(playlist.id);

    // Check if this playlist is movie mode
    if (playlist.isMovieMode) {
      // Enter movie mode
      if (this.state.movies.length > 0) {
        this.playMovie(0);
      } else {
        console.warn('No movies available');
      }
      return;
    }

    // Exit movie mode if we were in it
    if (this.state.isMovieMode) {
      this.stopMovie();
    }

    // Get last saved position, unless this is a live/noSave playlist
    const lastData = this.state.getPlaylistData(playlist.id);
    
    if (playlist.noSave) lastData.currentTime = 0;

    if (!this.youtubePlayer) {
      console.error('YouTube player not initialized');
      return;
    }

    // Stop save interval
    this.state.stopAutoSave();

    // Pause YouTube briefly before loading
    this.youtubePlayer.stopVideo();

    setTimeout(() => {
      const loadParams = {
        listType: 'playlist',
        list: playlist.id,
        index: lastData.videoIndex || 0,
        startSeconds: lastData.currentTime || 0,
      };

      this.youtubePlayer.loadPlaylist(loadParams);
      
      // After loading, check if we need to seek to saved position of this specific video
      setTimeout(() => {
        this.restoreVideoProgress();
      }, 500);
      
      // Ensure video plays automatically
      this.youtubePlayer.playVideo();
      
    }, 1000);
  }

  /**
   * Play movie by index
   */
  playMovie(index) {
    if (index < 0 || index >= this.state.movies.length) {
      console.warn(`Invalid movie index: ${index}`);
      return;
    }

    const filename = this.state.movies[index];
    console.log(`Playing movie ${index}: ${filename}`);

    if (!this.moviePlayer) {
      console.error('Movie player not initialized');
      return;
    }

    // Pause YouTube
    if (this.youtubePlayer) {
      this.youtubePlayer.pauseVideo();
    }

    // Stop save interval
    this.state.stopAutoSave();

    // Switch to movie mode
    this.state.switchToMovieMode(true);
    this.state.setCurrentMovie(filename);

    // Get last playback position
    const lastData = this.state.getMovieData(filename);
    const lastTime = lastData.currentTime || 0;

    // Load and play movie via API endpoint
    this.moviePlayer.src = `${this.apiClient.baseUrl}/get-movie/${encodeURIComponent(filename)}`;
    this.moviePlayer.currentTime = lastTime;
    this.moviePlayer.play();

    this.movieContainer.classList.add('open');

    // Start auto-save
    this.state.startAutoSave(() => {
      this.saveMovieProgress();
    });

    this.emit('movieLoaded', { index, filename });
  }

  /**
   * Stop movie and return to YouTube
   */
  stopMovie() {
    if (!this.state.isMovieMode) {
      return;
    }

    console.log('Stopping movie, returning to YouTube');

    if (this.moviePlayer) {
      this.saveMovieProgress();
      this.moviePlayer.pause();
    }

    this.movieContainer.classList.remove('open');

    this.state.switchToMovieMode(false);
    this.state.setCurrentMovie(null);
    this.state.stopAutoSave();

    if (this.youtubePlayer) {
      this.youtubePlayer.playVideo();
    }

    this.emit('movieStopped');
  }

  /**
   * Restore progress for the currently playing video
   */
  restoreVideoProgress() {
    if (!this.youtubePlayer || !this.state.currentPlaylistId) {
      return;
    }

    const playlistData = this.state.playlistData[this.state.currentPlaylistId];
    if (!playlistData?.videos) {
      return;
    }

    const currentVideoId = this.youtubePlayer.getVideoData().video_id;
    const videoKey = `${this.state.currentPlaylistId}|${currentVideoId}`;

    if (playlistData.videos[videoKey]) {
      const savedTime = playlistData.videos[videoKey].currentTime;
      if (savedTime > 0) {
        this.youtubePlayer.seekTo(savedTime, true);
        console.log(`Restored video ${currentVideoId} to ${Math.floor(savedTime)}s`);
      }
    }
  }

  /**
   * Save current playlist progress
   */
  savePlaylistProgress() {
    if (!this.youtubePlayer || !this.state.currentPlaylistId) {
      return;
    }

    const videoId = this.youtubePlayer.getVideoData().video_id;
    const videoIndex = this.youtubePlayer.getPlaylistIndex();
    const currentTime = this.youtubePlayer.getCurrentTime();

    // Create a key combining playlistId and videoId to track each video individually
    const videoKey = `${this.state.currentPlaylistId}|${videoId}`;

    // Save individual video progress
    const data = {
      videoId,
      videoIndex,
      currentTime,
      videos: this.state.playlistData[this.state.currentPlaylistId]?.videos || {},
    };

    // Track this specific video
    data.videos[videoKey] = {
      videoId,
      currentTime,
      timestamp: Date.now(),
    };

    this.state.setPlaylistData(this.state.currentPlaylistId, data);

    // Send to server
    this.apiClient.savePlaylistProgress(this.state.playlistData)
      .catch(err => console.warn('Failed to save playlist progress:', err));
  }

  /**
   * Save current movie progress
   */
  saveMovieProgress() {
    if (!this.moviePlayer || !this.state.currentMovieFile) {
      return;
    }

    const data = {
      currentTime: this.moviePlayer.currentTime,
    };

    this.state.setMovieData(this.state.currentMovieFile, data);

    // Send to server
    this.apiClient.saveMovieProgress(this.state.movieData)
      .catch(err => console.warn('Failed to save movie progress:', err));
  }

  /**
   * Handle YouTube player state changes
   */
  onYouTubePlayerStateChange(state) {
    const YT = window.YT;
    
    // Ignore if in movie mode
    if (this.state.isMovieMode) {
      if (this.youtubePlayer && typeof this.youtubePlayer.pauseVideo === 'function') {
        this.youtubePlayer.pauseVideo();
      }
      return;
    }

    if (state === YT.PlayerState.PLAYING) {
      // Check if video changed (navigating within playlist)
      const videoId = this.youtubePlayer.getVideoData().video_id;
      if (videoId !== this.currentVideoId) {
        this.currentVideoId = videoId;
        // Restore progress for this video
        this.restoreVideoProgress();
      }
      
      // Start auto-save
      this.state.startAutoSave(() => {
        this.savePlaylistProgress();
      });
    } else if (state === YT.PlayerState.ENDED) {
      // Play next video
      if (this.youtubePlayer) {
        this.youtubePlayer.playVideo();
      }
    } else {
      // Pause, stop, etc.
      this.state.stopAutoSave();
    }
  }
}

export default PlayerManager;
