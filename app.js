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
import { MovieLibrary } from './modules/MovieLibrary.js';
import { MovieBrowser } from './modules/MovieBrowser.js';
import { MovieControls } from './modules/MovieControls.js';
import { VirtualKeyboard } from './modules/VirtualKeyboard.js';
import { MovieDownloader } from './modules/MovieDownloader.js';
import { startRetroClock } from './modules/RetroClock.js';

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
  movieLibrary: null,
  movieBrowser: null,
  movieControls: null,
  virtualKeyboard: null,
  movieDownloader: null,
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

    // 3. Initialize player manager + movie library/browser/controls
    console.log('Initializing player manager...');
    app.playerManager = new PlayerManager(state, apiClient);

    app.movieLibrary = new MovieLibrary(apiClient);
    app.playerManager.setLibrary(app.movieLibrary);
    app.movieBrowser = new MovieBrowser(app.movieLibrary).init();
    app.movieControls = new MovieControls().init();
    app.virtualKeyboard = new VirtualKeyboard().init();
    app.movieDownloader = new MovieDownloader(apiClient, voiceAnnouncer).init();
    startRetroClock(); // horloge/date des en-têtes rétro
    attachMovieHandlers();

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

// Dernière position connue du curseur (pour scroller la boîte survolée).
const lastMouse = { x: 0, y: 0 };
window.addEventListener('mousemove', (e) => {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
}, { passive: true });

/** Vrai quand on est « sur la chaîne Movies » (film joué ou un overlay ouvert). */
function inMovieUI() {
  return state.isMovieMode
    || (app.movieBrowser && app.movieBrowser.isOpen)
    || (app.virtualKeyboard && app.virtualKeyboard.isOpen)
    || (app.movieControls && app.movieControls.isOpen)
    || (app.movieDownloader && app.movieDownloader.isOpen);
}

/**
 * Fait défiler la boîte scrollable située sous le curseur.
 * @param {number} dir -1 = vers le haut, +1 = vers le bas.
 */
function scrollHovered(dir) {
  let node = document.elementFromPoint(lastMouse.x, lastMouse.y);
  const step = Math.round(window.innerHeight * 0.28) * dir;
  while (node && node !== document.body) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      node.scrollBy({ top: step, behavior: 'smooth' });
      return;
    }
    node = node.parentElement;
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
    const playlist = state.playlists[index];

    // La "chaîne" Movies ouvre la bibliothèque (choix au curseur) au lieu de
    // lancer un film en aveugle.
    if (playlist && playlist.isMovieMode) {
      state.setCurrentPlaylist(playlist.id);
      // Coupe la vidéo YouTube en cours avant d'ouvrir la bibliothèque.
      if (state.player && typeof state.player.pauseVideo === 'function') {
        state.player.pauseVideo();
      }
      app.movieBrowser.open();
      return;
    }

    // Toute autre chaîne : fermer la bibliothèque puis jouer la playlist.
    if (app.movieBrowser.isOpen) app.movieBrowser.close();
    app.movieControls.hide();
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
      app.playerManager.playNextMovie();
    } else if (state.player) {
      state.player.nextVideo();
    }
  });

  kb.on('previous', () => {
    if (state.isMovieMode) {
      app.playerManager.playPreviousMovie();
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
    if (inMovieUI()) { scrollHovered(-1); return; }
    app.alarmManager.adjustTime(10);
    app.alarmManager.enable();
    // Announce adjusted time
    const [h, m] = app.state.alarmTime.split(':');
    app.voiceAnnouncer.announceTime(parseInt(h), parseInt(m), 0.8);
  });

  kb.on('alarm-time-down', () => {
    if (inMovieUI()) { scrollHovered(1); return; }
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
 * Attach movie library / browser / controls handlers.
 * Toute la nouvelle interaction film passe par le curseur souris (clics).
 */
function attachMovieHandlers() {
  const browser = app.movieBrowser;
  const controls = app.movieControls;
  const pm = app.playerManager;

  // Clic sur une affiche → lecture (avec la file triée pour next/previous)
  browser.on('play', (entry) => {
    const queue = app.movieLibrary.items();
    const index = queue.findIndex((e) => e.id === entry.id);
    browser.close();
    controls.hide();
    pm.playLibraryItem(entry, queue, index);
  });

  // Bouton "Rechercher" → clavier virtuel → recherche → téléchargement
  const keyboard = app.virtualKeyboard;
  const downloader = app.movieDownloader;

  // Raccourcis de pied de page [MOVIES] / [SEARCH], communs aux 4 écrans.
  const goLibrary = () => {
    if (state.isMovieMode) pm.stopMovie();
    controls.hide();
    keyboard.close();
    downloader.close();
    browser.open();
  };
  const goSearch = () => {
    controls.hide();
    downloader.close();
    keyboard.open();
  };
  for (const mod of [browser, keyboard, downloader, controls]) {
    mod.on('nav-library', goLibrary);
    mod.on('nav-search', goSearch);
  }

  keyboard.on('submit', (query) => {
    keyboard.close();
    downloader.search(query);
  });

  // Nouveau téléchargement lancé → faire apparaître sa tuile aussitôt.
  downloader.on('started', () => {
    if (browser.isOpen) browser.open();
  });

  // Progression → met à jour les tuiles en place (sans re-render).
  downloader.on('tick', (jobs) => {
    if (browser.isOpen) browser.syncActive(jobs);
  });

  // Un film devenu prêt → rafraîchir la bibliothèque si elle est ouverte
  downloader.on('ready', () => {
    if (browser.isOpen) browser.open();
  });

  // Affiche d'emblée un téléchargement déjà en cours (reload / repris au boot).
  // Le polling s'arrête tout seul s'il n'y a aucun job actif.
  downloader.startPolling();

  // Contrôles affichés quand le film est en pause
  controls.on('resume', () => {
    const p = pm.moviePlayer;
    if (p) {
      p.play().catch(() => {});
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  // Bascule 16:9 (letterbox) ⇄ 4:3 (crop).
  controls.on('set-fit', (mode) => pm.setFit(mode));
  // Choix explicite de la langue des sous-titres (English / French / None).
  controls.on('set-subtitles', (lang) => pm.setSubtitleMode(lang));
  // Choix de la piste audio (rangée visible seulement en multi-pistes).
  controls.on('set-audio', (index) => pm.setAudioTrack(index));
  // Recalage de la synchro des sous-titres (± ms par clic).
  controls.on('subtitle-offset', (delta) => {
    const offset = pm.adjustSubtitleOffset(delta);
    controls.setSubtitleOffsetLabel(offset);
  });

  // Reflète l'état courant sur les boutons (surlignage ambre).
  pm.on('subtitleModeChanged', (mode) => controls.setSubtitleActive(mode));
  pm.on('subtitleOffsetChanged', (offset) => controls.setSubtitleOffsetLabel(offset));
  pm.on('fitChanged', (mode) => controls.setFitActive(mode));
  // Langues de sous-titres disponibles → configure les rangées.
  pm.on('subtitlesAvailable', (langs) => {
    controls.setSubtitlesAvailable(langs);
    controls.setSubtitleActive(pm.subtitleMode);
  });
  // Pistes audio → construit la rangée AUDIO (masquée si mono-piste).
  pm.on('audioTracksChanged', (info) => controls.setAudioTracks(info.tracks, info.activeIndex));
  pm.on('audioTrackChanged', (index) => controls.setAudioActive(index));

  // Suppression d'un film depuis le volet détail.
  browser.on('delete', (entry) => {
    apiClient.deleteMovie(entry.id)
      .then(() => browser.open())
      .catch((err) => console.warn('Suppression échouée :', err));
  });

  // Clic sur la barre de progression → saut à la position + reprise.
  controls.on('seek', (ratio) => {
    const p = pm.moviePlayer;
    if (p && p.duration) {
      p.currentTime = ratio * p.duration;
      p.play().catch(() => {});
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
  // Afficher/masquer les contrôles selon l'état pause/play du film.
  // À la pause, on passe la progression + le temps pour remplir l'en-tête.
  const video = document.getElementById('movie-player');
  const ratioOf = () => (video.duration ? video.currentTime / video.duration : 0);
  if (video) {
    video.addEventListener('pause', () => {
      if (state.isMovieMode && !video.ended) {
        controls.setFitActive(pm.getFit());
        controls.show(ratioOf(), video.currentTime, video.duration);
      }
    });
    video.addEventListener('play', () => controls.hide());
    video.addEventListener('ended', () => controls.show(1, video.duration, video.duration));
  }
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
      cc_load_policy: 0,
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
  disableCaptions(event.target);
  document.body.focus();
}

/**
 * Force-disable YouTube captions (overrides the user's YouTube preference)
 */
function disableCaptions(player) {
  if (player.unloadModule) {
    player.unloadModule('captions'); // HTML5 player
    player.unloadModule('cc');       // Flash/legacy player
  }
}

/**
 * YouTube player state change callback
 */
function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    disableCaptions(event.target);
  }
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
