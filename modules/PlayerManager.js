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
    this.library = null; // MovieLibrary, injecté via setLibrary()
    this.youtubePlayer = null;
    this.moviePlayer = null;
    this.movieContainer = null;
    this.currentVideoId = null; // Track current video to detect changes

    // File de lecture des films (issue du tri de la bibliothèque)
    this.movieQueue = [];
    this.movieIndex = -1;
    this.currentEntry = null;
    this.subtitleMode = 'off'; // 'off' | 'fr' | 'en'
    this.subtitleOffset = 0; // décalage sous-titres en secondes (+ = plus tard)
  }

  /**
   * Injecte le modèle de bibliothèque (source des films et de leur progression).
   */
  setLibrary(library) {
    this.library = library;
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

    // Marque le film comme "vu" quand il se termine.
    this.moviePlayer.addEventListener('ended', () => this.markWatched());

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

    // La "chaîne" Movies n'auto-lance plus rien : app.js ouvre la bibliothèque
    // (MovieBrowser) et l'utilisateur choisit un film au curseur.
    if (playlist.isMovieMode) {
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
   * Joue une entrée de la bibliothèque.
   * @param {object} entry  entrée library.json (id, file, subtitles, currentTime...)
   * @param {object[]} [queue]  liste ordonnée servant à next/previous
   * @param {number} [index]  position de `entry` dans `queue`
   */
  playLibraryItem(entry, queue = null, index = null) {
    if (!entry || !entry.file) {
      console.warn('playLibraryItem: entrée invalide', entry);
      return;
    }
    if (!this.moviePlayer) {
      console.error('Movie player not initialized');
      return;
    }

    if (Array.isArray(queue)) {
      this.movieQueue = queue;
      this.movieIndex = index != null ? index : queue.findIndex((e) => e.id === entry.id);
    }
    this.currentEntry = entry;

    console.log(`Playing movie: ${entry.title || entry.id} (${entry.file})`);

    // Pause YouTube
    if (this.youtubePlayer) {
      this.youtubePlayer.pauseVideo();
    }

    this.state.stopAutoSave();
    this.state.switchToMovieMode(true);
    this.state.setCurrentMovie(entry.id);

    // Source + sous-titres + reprise à la position sauvegardée
    this.moviePlayer.src = `${this.apiClient.baseUrl}/get-movie/${encodeURIComponent(entry.file)}`;
    this.attachSubtitles(entry);
    const resumeAt = entry.currentTime || 0;
    const seekOnce = () => {
      if (resumeAt > 0) this.moviePlayer.currentTime = resumeAt;
      // Pistes audio connues une fois les métadonnées chargées.
      const info = this.audioTrackInfo();
      this.emit('audioTracksChanged', info);
      this.moviePlayer.removeEventListener('loadedmetadata', seekOnce);
    };
    this.moviePlayer.addEventListener('loadedmetadata', seekOnce);
    this.moviePlayer.play().catch(() => {});

    this.movieContainer.classList.add('open');

    this.state.startAutoSave(() => this.saveMovieProgress());

    this.emit('movieLoaded', { entry, index: this.movieIndex });
  }

  /**
   * (Re)crée les pistes de sous-titres <track> pour l'entrée courante.
   */
  attachSubtitles(entry) {
    // Retire les anciennes pistes
    this.moviePlayer.querySelectorAll('track').forEach((t) => t.remove());
    this.subtitleTracks = {};
    this.subtitleOffset = 0;

    const subs = entry.subtitles || {};
    const langs = Object.keys(subs);
    const labels = { fr: 'Français', en: 'English' };

    // Signale les langues de sous-titres disponibles : les contrôles associés
    // s'adaptent (masqués si la liste est vide).
    this.emit('subtitlesAvailable', langs.slice());

    // Mode restauré depuis la sauvegarde du film si encore valide, sinon
    // français en priorité, sinon la 1re langue (activés par défaut).
    const savedMode = entry.subtitleMode;
    const defaultLang = (savedMode && (savedMode === 'off' || langs.includes(savedMode)))
      ? savedMode
      : (langs.includes('fr') ? 'fr' : (langs[0] || 'off'));

    for (const lang of langs) {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.srclang = lang;
      track.label = labels[lang] || lang;
      track.src = this.apiClient.subtitleUrl(entry.id, lang);
      // Attribut natif : une seule piste visible au départ (fiable dès le 1er rendu).
      if (lang === defaultLang) track.default = true;
      this.moviePlayer.appendChild(track);
      this.subtitleTracks[lang] = track;
    }

    this.subtitleMode = defaultLang;
    // Décalage restauré depuis la sauvegarde du film (appliqué une fois les
    // cues chargées).
    const savedOffset = entry.subtitleOffset || 0;
    this.subtitleOffset = 0;
    // Régler le mode juste après l'ajout n'est pas fiable (pistes pas encore
    // chargées) : on ré-applique une fois la vidéo prête pour forcer UNE langue
    // et appliquer le décalage mémorisé.
    this.moviePlayer.addEventListener('loadeddata', () => {
      this.applySubtitleMode();
      if (savedOffset) this.adjustSubtitleOffset(savedOffset);
    }, { once: true });
    this.applySubtitleMode();
    this.emit('subtitleModeChanged', this.subtitleMode);
    this.emit('subtitleOffsetChanged', this.subtitleOffset);
  }

  /** Persiste langue + décalage des sous-titres dans l'entrée courante. */
  saveSubtitleSettings() {
    if (!this.currentEntry) return;
    const fields = {
      subtitleMode: this.subtitleMode,
      subtitleOffset: this.subtitleOffset,
    };
    Object.assign(this.currentEntry, fields);
    this.apiClient
      .saveLibraryEntry(this.currentEntry.id, fields)
      .catch((err) => console.warn('Failed to save subtitle settings:', err));
  }

  /**
   * Passe au mode de sous-titres suivant : off → fr → en → off
   * (en ne proposant que les langues réellement disponibles).
   */
  cycleSubtitles() {
    const available = Object.keys(this.subtitleTracks || {});
    const cycle = ['off', ...available];
    const next = cycle[(cycle.indexOf(this.subtitleMode) + 1) % cycle.length];
    this.subtitleMode = next;
    this.applySubtitleMode();
    this.saveSubtitleSettings();
    this.emit('subtitleModeChanged', next);
    return next;
  }

  /** Choix explicite de la langue de sous-titres ('fr'|'en'|'off'). */
  setSubtitleMode(mode) {
    if (mode !== 'off' && !(this.subtitleTracks && this.subtitleTracks[mode])) return this.subtitleMode;
    this.subtitleMode = mode;
    this.applySubtitleMode();
    this.saveSubtitleSettings();
    this.emit('subtitleModeChanged', mode);
    return mode;
  }

  applySubtitleMode() {
    const tracks = this.moviePlayer.textTracks || [];
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = tracks[i].language === this.subtitleMode ? 'showing' : 'disabled';
    }
  }

  /** Bascule letterbox (contain) ⇄ crop (cover) sans réencoder. */
  setFit(mode) {
    if (!this.moviePlayer) return;
    this.moviePlayer.classList.toggle('crop', mode === 'cover');
    this.emit('fitChanged', mode);
  }

  /** Mode d'affichage courant ('contain' | 'cover'). */
  getFit() {
    return this.moviePlayer && this.moviePlayer.classList.contains('crop') ? 'cover' : 'contain';
  }

  /**
   * Pistes audio du fichier courant, si l'API `audioTracks` est exposée par le
   * navigateur (sinon liste vide → la rangée AUDIO reste masquée).
   * @returns {{tracks:Array<{index:number,label:string}>, activeIndex:number}}
   */
  audioTrackInfo() {
    const at = this.moviePlayer && this.moviePlayer.audioTracks;
    if (!at || at.length <= 1) return { tracks: [], activeIndex: 0 };
    const names = { fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian' };
    const tracks = [];
    let activeIndex = 0;
    for (let i = 0; i < at.length; i++) {
      const t = at[i];
      const lang = (t.language || '').slice(0, 2).toLowerCase();
      tracks.push({ index: i, label: names[lang] || t.label || t.language || `Piste ${i + 1}` });
      if (t.enabled) activeIndex = i;
    }
    return { tracks, activeIndex };
  }

  /** Active une piste audio par index (si supporté). */
  setAudioTrack(index) {
    const at = this.moviePlayer && this.moviePlayer.audioTracks;
    if (!at) return;
    for (let i = 0; i < at.length; i++) at[i].enabled = (i === index);
    this.emit('audioTrackChanged', index);
  }

  /**
   * Décale la synchro des sous-titres de `delta` secondes (+ = plus tard).
   * Applique le décalage aux cues déjà chargées de toutes les pistes.
   * @returns {number} le décalage total courant, en secondes.
   */
  adjustSubtitleOffset(delta) {
    const tracks = this.moviePlayer.textTracks || [];
    for (let i = 0; i < tracks.length; i++) {
      const cues = tracks[i].cues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        cues[j].startTime = Math.max(0, cues[j].startTime + delta);
        cues[j].endTime = Math.max(0, cues[j].endTime + delta);
      }
    }
    this.subtitleOffset = Math.round((this.subtitleOffset + delta) * 100) / 100;
    this.saveSubtitleSettings();
    this.emit('subtitleOffsetChanged', this.subtitleOffset);
    return this.subtitleOffset;
  }

  /** Film suivant dans la file de lecture. */
  playNextMovie() {
    if (this.movieIndex < 0 || this.movieIndex >= this.movieQueue.length - 1) return;
    this.saveMovieProgress();
    this.playLibraryItem(this.movieQueue[this.movieIndex + 1], this.movieQueue, this.movieIndex + 1);
  }

  /** Film précédent dans la file de lecture. */
  playPreviousMovie() {
    if (this.movieIndex <= 0) return;
    this.saveMovieProgress();
    this.playLibraryItem(this.movieQueue[this.movieIndex - 1], this.movieQueue, this.movieIndex - 1);
  }

  /** Marque le film courant comme vu dans la bibliothèque. */
  markWatched() {
    if (!this.currentEntry) return;
    const id = this.currentEntry.id;
    this.currentEntry.watched = true;
    this.apiClient
      .saveLibraryEntry(id, { watched: true, currentTime: this.moviePlayer.currentTime || 0 })
      .catch((err) => console.warn('Failed to mark watched:', err));
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
    this.currentEntry = null;
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

    // GARDE-FOU : ne jamais écraser la progression si le chargement initial a
    // échoué (sinon l'auto-save réécrirait le fichier serveur avec du vide).
    if (!this.state.dataLoadedOk) {
      return;
    }

    // Ne pas polluer la progression YouTube quand la "chaîne" courante est le
    // mode film (bibliothèque ouverte ou film en cours).
    const current = this.state.playlists.find(p => p.id === this.state.currentPlaylistId);
    if (this.state.isMovieMode || (current && current.isMovieMode)) {
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
   * Persiste la progression du film courant dans la bibliothèque.
   * On envoie aussi `duration` pour que le backend puisse dériver le flag "vu".
   */
  saveMovieProgress() {
    if (!this.moviePlayer || !this.currentEntry) {
      return;
    }

    const fields = { currentTime: this.moviePlayer.currentTime || 0 };
    if (this.moviePlayer.duration && !Number.isNaN(this.moviePlayer.duration)) {
      fields.duration = this.moviePlayer.duration;
    }
    // Cache local pour un tri immédiat sans refetch
    Object.assign(this.currentEntry, fields);

    this.apiClient
      .saveLibraryEntry(this.currentEntry.id, fields)
      .catch((err) => console.warn('Failed to save movie progress:', err));
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
