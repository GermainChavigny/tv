/**
 * UI Controller Module
 * Manages UI updates and DOM interactions
 */

import { EventEmitter } from './EventEmitter.js';

export class UIController extends EventEmitter {
  constructor(state) {
    super();
    this.state = state;
    this.cursorHideTimeout = null;
    this.channelsSelectorTimer = null;
    this.channelsSelectorInterval = null;
  }

  /**
   * Initialize UI event listeners
   */
  init() {
    this.initCursorHandling();
    this.initBrightnessUI();
    this.initChannelsSelector();
    this.subscribeToStateChanges();
  }

  /**
   * Initialize cursor auto-hide functionality
   */
  initCursorHandling() {
    const showCursor = () => {
      document.body.style.cursor = 'auto';
      this.state.setCursorVisible(true);
      clearTimeout(this.cursorHideTimeout);
      this.cursorHideTimeout = setTimeout(() => this.hideCursor(), 3000);
    };

    const hideCursor = () => {
      document.body.style.cursor = 'none';
      this.state.setCursorVisible(false);
    };

    this.hideCursor = hideCursor;

    document.addEventListener('mousemove', showCursor);
    document.addEventListener('mousedown', showCursor);

    // Hide cursor initially
    showCursor();
  }

  /**
   * Initialize brightness controls
   */
  initBrightnessUI() {
    const darkDiv = document.getElementById('dark');
    if (darkDiv) {
      this.darkDiv = darkDiv;
    }
  }

  /**
   * Initialize channels selector UI
   */
  initChannelsSelector() {
    const channelsContainer = document.getElementById('channels');
    if (!channelsContainer) {
      console.warn('Channels container not found');
      return;
    }

    this.channelsContainer = channelsContainer;
    this.renderChannels();
    this.startChannelsSelectorUpdates();
  }

  /**
   * Render channel logos in the selector
   */
  renderChannels() {
    if (!this.channelsContainer) return;

    const template = this.channelsContainer.querySelector('.channel');
    if (!template) return;

    // Clear existing
    const existing = this.channelsContainer.querySelectorAll('.channel');
    existing.forEach((el, i) => {
      if (i > 0) el.remove();
    });

    // Create channels
    this.state.playlists.forEach((playlist, index) => {
      const clone = template.cloneNode(true);
      clone.classList.add(`playlist-${index}`);
      clone.dataset.playlistId = playlist.id;

      const img = clone.querySelector('img');
      if (img) {
        img.src = `logos/${playlist.logo}`;
        img.alt = playlist.name;
      }

      this.channelsContainer.appendChild(clone);
    });

    // destroy template
    template.remove();
  }

  /**
   * Start updating channels selector visibility
   */
  startChannelsSelectorUpdates() {
    let timer = 3000;

    this.channelsSelectorInterval = setInterval(() => {
      timer -= 100;

      // Update visibility
      const isVisible = timer > 0;
      this.channelsContainer.classList.toggle('visible', isVisible);

      // Update current channel highlight
      if (this.state.currentPlaylistId && window.YT) {
        this.channelsContainer.querySelectorAll('.channel').forEach(ch => {
          const isCurrent = ch.dataset.playlistId === this.state.currentPlaylistId;
          ch.classList.toggle('current', isCurrent);
        });
      }
    }, 100);

    // Reset timer when playlist changes
    this.state.on('currentPlaylistChanged', () => {
      timer = 2000;
    });
  }

  /**
   * Update brightness (dark overlay opacity)
   */
  setBrightness(opacity) {
    if (this.darkDiv) {
      this.darkDiv.style.opacity = opacity;
    }
  }

  /**
   * Subscribe to state changes for UI updates
   */
  subscribeToStateChanges() {
    this.state.on('brightnessChanged', (opacity) => {
      this.setBrightness(opacity);
    });

    this.state.on('movieModeChanged', (isMovie) => {
      if (isMovie) {
        this.disableYouTubeControls();
      } else {
        this.enableYouTubeControls();
      }
    });
  }

  /**
   * Disable YouTube player controls (when in movie mode)
   */
  disableYouTubeControls() {
    const iframe = document.querySelector('iframe');
    if (iframe) {
      iframe.style.pointerEvents = 'none';
    }
  }

  /**
   * Enable YouTube player controls
   */
  enableYouTubeControls() {
    const iframe = document.querySelector('iframe');
    if (iframe) {
      iframe.style.pointerEvents = 'auto';
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.cursorHideTimeout) {
      clearTimeout(this.cursorHideTimeout);
    }
    if (this.channelsSelectorInterval) {
      clearInterval(this.channelsSelectorInterval);
    }
  }
}

export default UIController;
