/**
 * Main Application Bootstrap
 * Initializes and orchestrates all modules
 */


import config from './config.js';
import state from './modules/StateManager.js';
import { apiClient } from './modules/ApiClient.js';
import { PlayerManager } from './modules/PlayerManager.js';
import { KeyboardHandler } from './modules/KeyboardHandler.js';
import { AlarmManager } from './modules/AlarmManager.js';
import TVPowerControl from './modules/TVPowerControl.js';
import { UIController } from './modules/UIController.js';
import voiceAnnouncer from './modules/VoiceAnnouncer.js';

// Global app instance
const app = {
  config,
  state,
  apiClient,
  playerManager: null,
  keyboardHandler: null,
  alarmManager: null,
  tvPower: null,
  uiController: null,
  voiceAnnouncer,
};

/**
 * Initialize all modules in correct order
 */
async function bootstrap() {
  console.log('🚀 Starting TV App');
  console.log('OS:', config.os);
  console.log('Config:', config);

  try {
    // 1. Load data from server
    console.log('Loading data from server...');
    await state.loadAllData(apiClient);

    // 2. Initialize UI
    console.log('Initializing UI...');
    app.uiController = new UIController(state);
    app.uiController.init();

    // 3. Initialize player manager
    console.log('Initializing player manager...');
    app.playerManager = new PlayerManager(state, apiClient);

    // 4. Initialize keyboard handler
    console.log('Initializing keyboard handler...');
    app.keyboardHandler = new KeyboardHandler();
    app.keyboardHandler.start();
    attachKeyboardHandlers();

    // 5. Initialize TV power control
    console.log('Initializing TV power control...');
    app.tvPower = new TVPowerControl(apiClient);

    // 6. Initialize alarm manager
    console.log('Initializing alarm manager...');
    app.alarmManager = new AlarmManager(state, apiClient);
    await app.alarmManager.load(); // Load alarm settings from server
    attachAlarmHandlers();

    // 7. Load YouTube API
    console.log('Loading YouTube API...');
    loadYouTubeAPI();

    // Global app reference for debugging
    window.tvApp = app;

    console.log('✅ TV App initialized successfully');
  } catch (err) {
    console.error('❌ Bootstrap error:', err);
  }
}

/**
 * Attach keyboard event handlers
 */
function attachKeyboardHandlers() {
  const kb = app.keyboardHandler;

  // Stop progressive alarm on any user interaction
  kb.on('user-interaction', () => {
    app.alarmManager.stopProgressiveAlarm();
  });

  // Turn on TV on any interaction except power-off
  kb.on('none-power-off-interaction', () => {
    app.tvPower.powerOn().catch(() => {});
  });

  // Playlist selection
  kb.on('playlist', (index) => {
    console.log(`Selected playlist ${index}`);
    app.playerManager.playPlaylist(index);
  });

  // Volume control
  kb.on('power-off', () => {
    
    if (state.isMovieMode && state.moviePlayer) {
      state.moviePlayer.pause();
    } else if (state.player) {

      if (app.tvPower.isOn) {
        app.tvPower.powerOff().catch(() => {});
        if (state.player.getPlayerState() === 1) { // PLAYING
            state.player.pauseVideo();      
        }
      } else {
        app.tvPower.powerOn().catch(() => {});
      }
      
    }
  });

  kb.on('volume-up', () => {
    if (state.isMovieMode && state.moviePlayer) {
      const newVol = Math.min(100, state.moviePlayer.volume * 100 + 5);
      state.moviePlayer.volume = newVol / 100;
    } else if (state.player) {
      state.player.setVolume(state.player.getVolume() + 5);
    }
  });

  kb.on('volume-down', () => {
    if (state.isMovieMode && state.moviePlayer) {
      const newVol = Math.max(0, state.moviePlayer.volume * 100 - 5);
      state.moviePlayer.volume = newVol / 100;
    } else if (state.player) {
      state.player.setVolume(state.player.getVolume() - 5);
    }
  });

  // Play/Pause
  kb.on('play-pause', () => {
    if (state.isMovieMode && state.moviePlayer) {
      if (state.moviePlayer.paused) {
        state.moviePlayer.play();
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        state.moviePlayer.pause();
      }
    } else if (state.player) {
      const playerState = state.player.getPlayerState();
      if (playerState === 2) { // PAUSED
        state.player.playVideo();
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        state.player.pauseVideo();
      }
    }
  });

  // Next/Previous
  kb.on('next', () => {
    if (state.isMovieMode) {
      const currentIdx = state.movies.indexOf(state.currentMovieFile);
      if (currentIdx < state.movies.length - 1) {
        app.playerManager.playMovie(currentIdx + 1);
      }
    } else if (state.player) {
      state.player.nextVideo();
    }
  });

  kb.on('previous', () => {
    if (state.isMovieMode) {
      const currentIdx = state.movies.indexOf(state.currentMovieFile);
      if (currentIdx > 0) {
        app.playerManager.playMovie(currentIdx - 1);
      }
    } else if (state.player) {
      state.player.previousVideo();
    }
  });

  // Seek
  kb.on('seek', (seconds) => {
    if (state.isMovieMode && state.moviePlayer) {
      state.moviePlayer.currentTime = Math.max(0, state.moviePlayer.currentTime + seconds);
    } else if (state.player) {
      state.player.seekTo(state.player.getCurrentTime() + seconds, true);
    }
  });

  // Brightness
  kb.on('brightness', (direction) => {
    if (direction === 'increase') {
      state.increaseBrightness();
    } else {
      state.decreaseBrightness();
    }
  });

  // Alarm adjustment
  kb.on('alarm-time-up', () => {
    app.alarmManager.adjustTime(10);
    app.alarmManager.enable();
    // Announce adjusted time
    const [h, m] = app.state.alarmTime.split(':');
    app.voiceAnnouncer.announceTime(parseInt(h), parseInt(m), 0.8);
  });

  kb.on('alarm-time-down', () => {
    app.alarmManager.adjustTime(-10);
    app.alarmManager.enable();
    // Announce adjusted time
    const [h, m] = app.state.alarmTime.split(':');
    app.voiceAnnouncer.announceTime(parseInt(h), parseInt(m), 0.8);
  });

  // Alarm toggle on/off
  kb.on('alarm-toggle', () => {
    if (app.state.alarmEnabled) {
      app.alarmManager.disable();
      app.voiceAnnouncer.announce('Pas de réveil', 0.8);
    } else {
      app.alarmManager.enable();
      app.voiceAnnouncer.announce('Réveil activé', 0.8);
    }
  });
}

/**
 * Attach alarm event handlers
 */
function attachAlarmHandlers() {
  const alarm = app.alarmManager;

  alarm.on('triggered', async () => {
    console.log('🔔 WAKE UP ALARM TRIGGERED!');
    try {
      await app.tvPower.powerOn();
      
      // Find and play the alarm playlist
      const alarmPlaylistIndex = state.playlists.findIndex(p => p.isAlarm);
      if (alarmPlaylistIndex >= 0) {
        app.playerManager.playPlaylist(alarmPlaylistIndex);
        
        // Start progressive alarm immediately
        alarm.startProgressiveAlarm(app.playerManager);
      } else {
        console.warn('No alarm playlist found');
      }
    } catch (err) {
      console.error('Error triggering alarm:', err);
    }
  });
}

/**
 * Load YouTube IFrame API
 */
function loadYouTubeAPI() {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.async = true;
  tag.defer = true;

  window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

  const firstScript = document.getElementsByTagName('script')[0];
  firstScript.parentNode.insertBefore(tag, firstScript);
}

/**
 * YouTube API callback
 */
window.onYouTubeIframeAPIReady = function() {
  console.log('YouTube IFrame API ready');

  const player = new YT.Player('player', {
    height: '300',
    width: '400',
    videoId: '6N5e0BQyF9I', //3zyOHgkEaO8
    playerVars: {
      autoplay: 1,
      controls: 1,
      loop: 1,
      modestbranding: 1,
      color: 'white',
      iv_load_policy: 3,
      rel: 0,
    },
    events: {
      onReady: (e) => onPlayerReady(e),
      onStateChange: (e) => onPlayerStateChange(e),
      onError: (e) => onPlayerError(e),
    },
  });

  app.playerManager.initYouTubePlayer(player);
};

/**
 * YouTube player ready callback
 */
function onPlayerReady(event) {
  console.log('YouTube player ready');
  event.target.setPlaybackQuality('hd720');
  document.body.focus();
}

/**
 * YouTube player state change callback
 */
function onPlayerStateChange(event) {
  app.playerManager.onYouTubePlayerStateChange(event.data);
}

/**
 * YouTube player error callback
 */
function onPlayerError(event) {
  console.error('YouTube error:', event.data);
}

/**
 * Initialize HTML5 movie player element
 */
function initMoviePlayer() {
  const moviePlayer = document.getElementById('movie-player');
  const movieContainer = document.getElementById('movie-container');
  if (!moviePlayer) {
    console.error('Movie player element not found');
    return;
  }

  app.playerManager.initMoviePlayer(moviePlayer, movieContainer);
}

/**
 * Start the application
 */
export async function start() {
  // Bootstrap all modules first
  await bootstrap();

  // Then initialize movie player (after playerManager is ready)
  initMoviePlayer();
}

// Auto-start on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

export default app;
