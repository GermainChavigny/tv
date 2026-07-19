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
import { MovieAdvisor } from './modules/MovieAdvisor.js';
import { SeriesPopup } from './modules/SeriesPopup.js';
import { SubtitleHud } from './modules/SubtitleHud.js';
import { startRetroClock } from './modules/RetroClock.js';
import { startWeather } from './modules/Weather.js';
import { VolumeOverlay } from './modules/VolumeOverlay.js';
import { WeatherPopup } from './modules/WeatherPopup.js';
import { startRetroFx } from './modules/RetroFx.js';
import { startRetroCursor } from './modules/RetroCursor.js';

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
  movieAdvisor: null,
  seriesPopup: null,
  subtitleHud: null,
  volumeOverlay: null,
  weatherPopup: null,
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
    // Vidéo d'intro locale (boucle native) : jouée au démarrage, retirée dès
    // qu'une chaîne ou un film prend le relais.
    const introEl = document.getElementById('intro-player');
    if (introEl) {
      app.playerManager.setIntroPlayer(introEl);
      introEl.play().catch(() => {}); // au cas où l'attribut autoplay ne parte pas
    }
    app.movieBrowser = new MovieBrowser(app.movieLibrary).init();
    app.movieControls = new MovieControls().init();
    app.virtualKeyboard = new VirtualKeyboard().init();
    app.movieDownloader = new MovieDownloader(apiClient, voiceAnnouncer).init();
    app.movieAdvisor = new MovieAdvisor(apiClient).init();
    app.seriesPopup = new SeriesPopup(apiClient).init();
    app.subtitleHud = new SubtitleHud().init();
    app.volumeOverlay = new VolumeOverlay().init();
    app.weatherPopup = new WeatherPopup().init();
    startRetroCursor(); // curseur rétro : image pixel suivant la souris (natif masqué)
    startRetroClock(); // horloge/date des en-têtes rétro
    startWeather();    // icône météo (prévision +1h de Tours) à côté de la date
    // Clic sur l'horloge/icône d'un en-tête → popup de prévisions du jour.
    document.addEventListener('click', (e) => {
      const cw = e.target.closest('.crt-clock-wrap');
      if (cw && cw.closest('.crt-header')) app.weatherPopup.toggle();
    });
    // Effet de chargement rétro + sons, branché sur les 5 overlays films.
    startRetroFx([
      app.movieBrowser.root, app.movieDownloader.root, app.movieAdvisor.root,
      app.virtualKeyboard.root, app.movieControls.root, app.seriesPopup.root,
    ]);
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
  // Souris bougée pendant la lecture → réveille le HUD de recalage des
  // sous-titres (il se rendort tout seul après quelques secondes).
  if (app.subtitleHud && state.isMovieMode && !anyMovieOverlayOpen()) {
    app.subtitleHud.wake();
  }
}, { passive: true });

/** Vrai si l'un des écrans films couvre l'image (le HUD doit alors s'effacer). */
function anyMovieOverlayOpen() {
  return (app.movieBrowser && app.movieBrowser.isOpen)
    || (app.virtualKeyboard && app.virtualKeyboard.isOpen)
    || (app.movieControls && app.movieControls.isOpen)
    || (app.movieDownloader && app.movieDownloader.isOpen)
    || (app.movieAdvisor && app.movieAdvisor.isOpen)
    || (app.seriesPopup && app.seriesPopup.isOpen);
}

/** Vrai quand on est « sur la chaîne Movies » (film joué ou un overlay ouvert). */
function inMovieUI() {
  return state.isMovieMode || anyMovieOverlayOpen();
}

/**
 * Fait défiler la boîte scrollable située sous le curseur.
 * @param {number} dir -1 = vers le haut, +1 = vers le bas.
 */
function scrollHovered(dir) {
  let node = document.elementFromPoint(lastMouse.x, lastMouse.y);
  const vStep = Math.round(window.innerHeight * 0.28) * dir;
  const hStep = Math.round(window.innerWidth * 0.28) * dir;
  while (node && node !== document.body) {
    const cs = getComputedStyle(node);
    // Vertical d'abord, puis horizontal (ex. barre de saisons de la popup séries).
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      node.scrollBy({ top: vStep, behavior: 'smooth' });
      return;
    }
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) {
      node.scrollBy({ left: hStep, behavior: 'smooth' });
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
  let openMoviesTimer = null;
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
      // On laisse le sélecteur de chaînes montrer la 9 sélectionnée avant
      // d'ouvrir la bibliothèque (sinon l'overlay la recouvre aussitôt).
      clearTimeout(openMoviesTimer);
      openMoviesTimer = setTimeout(() => {
        // Toujours sur la chaîne Movies ? (l'utilisateur a pu re-zapper.)
        if (state.currentPlaylistId === playlist.id && !app.movieBrowser.isOpen) {
          app.movieBrowser.open();
        }
      }, 900);
      return;
    }

    // Toute autre chaîne : annuler une ouverture Movies en attente puis jouer.
    clearTimeout(openMoviesTimer);
    if (app.movieBrowser.isOpen) app.movieBrowser.close();
    if (app.movieAdvisor.isOpen) app.movieAdvisor.close();
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

  // Ajuste le volume (film HTML5 ou YouTube) et affiche l'OSD rétro.
  const changeVolume = (delta) => {
    let pct = null;
    if (state.isMovieMode && state.moviePlayer) {
      pct = Math.max(0, Math.min(100, state.moviePlayer.volume * 100 + delta));
      state.moviePlayer.volume = pct / 100;
    } else if (state.player && typeof state.player.getVolume === 'function') {
      pct = Math.max(0, Math.min(100, state.player.getVolume() + delta));
      state.player.setVolume(pct);
    }
    if (pct !== null && app.volumeOverlay) app.volumeOverlay.show(pct);
  };
  kb.on('volume-up', () => changeVolume(5));
  kb.on('volume-down', () => changeVolume(-5));

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
  const hud = app.subtitleHud;

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

  // Raccourcis de pied de page [MOVIES] / [SEARCH] / [ADVISOR], communs à tous
  // les écrans films.
  const advisor = app.movieAdvisor;
  const seriesPopup = app.seriesPopup;
  const goLibrary = () => {
    if (state.isMovieMode) pm.stopMovie();
    controls.hide();
    hud.hide();
    keyboard.close();
    downloader.close();
    advisor.close();
    seriesPopup.close();
    browser.open();
  };
  const goSearch = () => {
    controls.hide();
    hud.hide();
    downloader.close();
    advisor.close();
    seriesPopup.close();
    keyboard.open();
  };
  const goAdvisor = () => {
    if (state.isMovieMode) pm.stopMovie();
    controls.hide();
    hud.hide();
    keyboard.close();
    downloader.close();
    seriesPopup.close();
    browser.close();
    advisor.open(); // restaure critères + recos (état jamais réinitialisé)
  };
  for (const mod of [browser, keyboard, downloader, controls, advisor, seriesPopup]) {
    mod.on('nav-library', goLibrary);
    mod.on('nav-search', goSearch);
    mod.on('nav-advisor', goAdvisor);
  }

  // Volet d'info d'une série → popup saisons/épisodes (par-dessus la bibliothèque).
  browser.on('open-series', (show) => seriesPopup.open(show));

  // Choix d'une série dans la recherche → l'enregistrer puis ouvrir la popup.
  downloader.on('add-series', async (movie) => {
    try {
      const res = await apiClient.addSeries(movie.tmdbId);
      downloader.close();
      if (res && res.show) seriesPopup.open(res.show);
    } catch (err) {
      console.warn('addSeries failed:', err);
    }
  });

  // Lecture d'un épisode (depuis la popup OU le bouton « Resume » du volet série).
  // File de lecture = épisodes prêts de la série (next/previous enchaîne).
  const playEpisode = async ({ showId, season, episode }) => {
    await app.movieLibrary.load(); // état frais (un épisode vient peut-être de finir)
    const pad = (n) => String(n).padStart(2, '0');
    const epId = `${showId}-s${pad(season)}e${pad(episode)}`;
    const entry = app.movieLibrary.get(epId);
    if (!entry || entry.status !== 'ready') return;
    const queue = Object.values(app.movieLibrary.entries)
      .filter((e) => e.type === 'episode' && e.showId === showId && e.status === 'ready')
      .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
    const index = queue.findIndex((e) => e.id === epId);
    seriesPopup.close();
    browser.close();
    controls.hide();
    pm.playLibraryItem(entry, queue, index);
  };
  seriesPopup.on('play-episode', playEpisode);
  browser.on('play-episode', playEpisode);

  // SEARCH sur une reco → l'écran de recherche torrent existant (titre seul).
  advisor.on('search-movie', ({ query, kind }) => {
    advisor.close();
    downloader.search(query, kind === 'series' ? 'series' : 'movie');
  });

  // Le clavier sert deux écrans : le purpose (posé à open()) dit où renvoyer.
  keyboard.on('submit', (text) => {
    keyboard.close();
    if (keyboard.purpose === 'advisor') {
      advisor.setKeywords(text); // l'advisor est resté ouvert dessous
    } else {
      downloader.search(text);
    }
  });

  // Champ libre du Movie Advisor : ouvre le clavier PAR-DESSUS (advisor non
  // fermé) pour y revenir à la validation comme à l'annulation.
  advisor.on('edit-keywords', () => {
    keyboard.open(advisor.keywords, {
      purpose: 'advisor',
      title: 'Movie Advisor',
      prompt: 'Extra keywords (actor, theme…):',
      submitLabel: 'OK',
    });
  });

  // Nouveau téléchargement lancé → basculer sur la bibliothèque, qui fait
  // office de liste des téléchargements (les jobs en cours sont en tête de tri).
  // Redirection explicite : selon le chemin emprunté (clavier ou advisor), la
  // bibliothèque n'est pas forcément restée ouverte derrière l'écran de
  // résultats — sans ça on retombe sur la chaîne YouTube.
  // La lecture en cours n'est PAS coupée : télécharger n'est pas quitter un film.
  downloader.on('started', () => {
    keyboard.close();
    advisor.close();
    browser.open(); // recharge le catalogue → la nouvelle entrée apparaît
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

  // Recalage des sous-titres : réglé en lecture depuis le HUD (± 0,1 s par clic).
  hud.on('subtitle-offset', (delta) => hud.setOffset(pm.adjustSubtitleOffset(delta)));

  // Reflète l'état courant sur les boutons (surlignage ambre).
  pm.on('subtitleModeChanged', (mode) => controls.setSubtitleActive(mode));
  pm.on('subtitleOffsetChanged', (offset) => hud.setOffset(offset));
  pm.on('fitChanged', (mode) => controls.setFitActive(mode));
  // Langues de sous-titres disponibles → configure la rangée et le HUD.
  pm.on('subtitlesAvailable', (langs) => {
    controls.setSubtitlesAvailable(langs);
    controls.setSubtitleActive(pm.subtitleMode);
    hud.setAvailable(langs.length > 0);
  });
  // Film arrêté → plus de sous-titres à recaler.
  pm.on('movieStopped', () => hud.setAvailable(false));
  // Pistes audio → construit la rangée AUDIO (masquée si mono-piste).
  pm.on('audioTracksChanged', (info) => controls.setAudioTracks(info.tracks, info.activeIndex));
  pm.on('audioTrackChanged', (index) => controls.setAudioActive(index));

  // Suppression d'un film depuis le volet détail.
  browser.on('delete', (entry) => {
    // Si le film est encore en cours de téléchargement/conversion, sa
    // disparition des jobs actifs ne doit PAS déclencher l'annonce « Film prêt ».
    downloader.ignoreJob(entry.id);
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
        controls.setMovieTitle(pm.currentEntry ? pm.currentEntry.title : '');
        controls.show(ratioOf(), video.currentTime, video.duration);
        hud.hide(); // l'overlay de pause recouvre l'image
      }
    });
    video.addEventListener('play', () => controls.hide());
    video.addEventListener('ended', () => {
      controls.setMovieTitle(pm.currentEntry ? pm.currentEntry.title : '');
      controls.show(1, video.duration, video.duration);
      hud.hide();
    });
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
      autoplay: 0,      // l'intro est la vidéo LOCALE ; YouTube attend une chaîne
      controls: 0,      // pas de barre de contrôle (kiosque piloté à la télécommande)
      disablekb: 1,     // le clavier ne pilote pas YouTube (géré par l'app)
      fs: 0,            // pas de bouton plein écran
      modestbranding: 1,
      playsinline: 1,
      color: 'white',
      iv_load_policy: 3, // pas d'annotations
      cc_load_policy: 0,
      rel: 0,            // pas de vidéos « liées » en fin
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
  // L'API peut finir de charger APRÈS l'entrée en mode film : avec autoplay,
  // YouTube démarrerait alors derrière le film. On le coupe d'emblée.
  guardYouTubeInMovieMode(event.target);
}

/**
 * Garde-fou : si un film est ouvert (mode film), YouTube ne doit JAMAIS jouer.
 * Appelé à chaque événement du player pour couvrir toutes les courses possibles.
 */
function guardYouTubeInMovieMode(player) {
  if (state.isMovieMode && player && typeof player.pauseVideo === 'function') {
    player.pauseVideo();
    return true;
  }
  return false;
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
  // Coupe immédiatement toute tentative de lecture pendant qu'un film est ouvert.
  if (event.data === YT.PlayerState.PLAYING && guardYouTubeInMovieMode(event.target)) {
    return;
  }
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
