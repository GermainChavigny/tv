"""
Movie pipeline — bibliothèque, téléchargement, sous-titres, transcodage.

Ce module contient toute la logique "lourde" du volet films ; api.py reste le
routeur Flask et se contente d'appeler ces classes.

Palier 1 (implémenté) : Library — lecture/écriture de tv_data/library.json,
source unique de vérité pour les films (métadonnées + progression + vu/pas-vu).

Paliers suivants (Indexer / Tmdb / Subtitles / Torrent / Transcoder / worker)
sont ajoutés ici au fur et à mesure.
"""

import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

try:
    import libtorrent as lt
except ImportError:  # permet d'importer le module même sans libtorrent installé
    lt = None

# Extensions vidéo reconnues comme "le film" dans un torrent multi-fichiers.
VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.ts', '.wmv', '.flv'}


def atomic_write_json(path, data):
    """
    Écrit du JSON de façon durable puis atomique.

    On écrit dans un fichier temporaire (flush + fsync) avant de le renommer sur
    la cible : une coupure de courant ne peut pas laisser un JSON tronqué. C'est
    le durcissement du pattern flush/fsync déjà présent dans api.py.
    """
    path = str(path)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Library:
    """
    Catalogue des films, persisté dans tv_data/library.json.

    Structure du fichier : un dict indexé par `id` (slug), chaque entrée portant
    métadonnées, statut de téléchargement, progression de lecture et flag vu.
    Voir le plan pour le schéma complet.
    """

    # Fraction de la durée au-delà de laquelle un film est considéré comme "vu".
    WATCHED_THRESHOLD = 0.92

    def __init__(self, data_dir, posters_dir):
        self.path = Path(data_dir) / "library.json"
        self.posters_dir = Path(posters_dir)
        self.posters_dir.mkdir(parents=True, exist_ok=True)
        # Un seul writer à la fois (worker de téléchargement + requêtes Flask).
        self._lock = threading.Lock()

    # ----- lecture -----

    def _read(self):
        if not self.path.exists():
            return {}
        try:
            with open(self.path, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as err:
            print(f"[Library] Lecture impossible ({err}), repart d'un catalogue vide")
            return {}

    def all(self):
        """Retourne le dict complet {id: entry}."""
        return self._read()

    def get(self, movie_id):
        return self._read().get(movie_id)

    # ----- écriture -----

    def upsert(self, entry):
        """Insère ou remplace une entrée complète (clé = entry['id'])."""
        with self._lock:
            data = self._read()
            data[entry["id"]] = entry
            atomic_write_json(self.path, data)
        return entry

    def patch(self, movie_id, fields):
        """
        Met à jour partiellement une entrée existante.

        Recalcule `watched` quand la progression ou la durée changent, pour que
        le flag reste cohérent sans que le client ait à le gérer.
        """
        with self._lock:
            data = self._read()
            entry = data.get(movie_id)
            if entry is None:
                return None
            entry.update(fields)
            duration = entry.get("duration") or 0
            current = entry.get("currentTime") or 0
            if duration > 0 and current >= self.WATCHED_THRESHOLD * duration:
                entry["watched"] = True
            data[movie_id] = entry
            atomic_write_json(self.path, data)
        return entry

    def delete(self, movie_id):
        with self._lock:
            data = self._read()
            entry = data.pop(movie_id, None)
            if entry is not None:
                atomic_write_json(self.path, data)
        return entry


class Transcoder:
    """
    Transcodage ffmpeg vers un MP4 lisible par le <video> web du kiosque.

    Recette reprise de movies/convert.bat (validée sur cette TV) :
    H.264 baseline 3.0, largeur 720 (letterbox géré côté lecteur), AAC 128k,
    +faststart pour lecture immédiate en streaming.
    """

    RECIPE = [
        '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
        '-preset', 'fast', '-vf', 'scale=720:-2',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
    ]

    # Vidéo déjà web-compatible (H.264) mais audio non (AC3/DTS…) : on COPIE la
    # vidéo (pas de ré-encodage coûteux) et on ne convertit que l'audio. Quasi
    # instantané comparé à un ré-encodage vidéo complet.
    RECIPE_AUDIO_ONLY = [
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
    ]

    # Langues de sous-titres embarqués à extraire (mkv notamment)
    SUB_LANGS = {'fre': 'fr', 'fra': 'fr', 'fr': 'fr', 'eng': 'en', 'en': 'en'}

    def __init__(self, ffmpeg='ffmpeg', ffprobe='ffprobe'):
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.process = None  # subprocess en cours (pour annulation)

    def available(self):
        return shutil.which(self.ffmpeg) is not None

    def probe_duration(self, src):
        """Durée de la vidéo en secondes (0 si indéterminable)."""
        try:
            out = subprocess.run(
                [self.ffprobe, '-v', 'error', '-show_entries', 'format=duration',
                 '-of', 'csv=p=0', str(src)],
                capture_output=True, text=True, timeout=30,
            ).stdout.strip()
            return float(out)
        except (ValueError, subprocess.SubprocessError, OSError):
            return 0.0

    def probe_subtitle_streams(self, src):
        """
        Liste les pistes de sous-titres texte embarquées : [(index, lang)].
        Seules les langues de SUB_LANGS sont retenues.
        """
        try:
            out = subprocess.run(
                [self.ffprobe, '-v', 'error', '-select_streams', 's',
                 '-show_entries', 'stream=index,codec_name:stream_tags=language',
                 '-of', 'json', str(src)],
                capture_output=True, text=True, timeout=30,
            ).stdout
            streams = json.loads(out).get('streams', [])
        except (json.JSONDecodeError, subprocess.SubprocessError, OSError):
            return []

        found = []
        text_codecs = {'subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt'}
        for s in streams:
            if s.get('codec_name') not in text_codecs:
                continue  # sous-titres bitmap (pgs/dvdsub) : inexploitables en vtt
            lang = self.SUB_LANGS.get((s.get('tags') or {}).get('language', '').lower())
            if lang:
                found.append((s['index'], lang))
        return found

    def probe_audio_streams(self, src):
        """
        Liste les pistes audio dans l'ordre de mux : [{index, lang, title}].
        `index` est l'ordre 0-based parmi les pistes AUDIO (aligné sur ce que le
        navigateur expose via `audioTracks`), pas l'index de flux global.
        """
        try:
            out = subprocess.run(
                [self.ffprobe, '-v', 'error', '-select_streams', 'a',
                 '-show_entries', 'stream_tags=language,title',
                 '-of', 'json', str(src)],
                capture_output=True, text=True, timeout=30,
            ).stdout
            streams = json.loads(out).get('streams', [])
        except (json.JSONDecodeError, subprocess.SubprocessError, OSError):
            return []

        tracks = []
        for i, s in enumerate(streams):
            tags = s.get('tags') or {}
            tracks.append({
                'index': i,
                'lang': (tags.get('language') or '').lower(),
                'title': tags.get('title') or '',
            })
        return tracks

    def extract_subtitles(self, src, out_dir, base_name):
        """
        Extrait les sous-titres embarqués fr/en en WebVTT.
        Retourne {lang: filename} (une seule piste par langue, la première).
        """
        subs = {}
        for index, lang in self.probe_subtitle_streams(src):
            if lang in subs:
                continue
            out_name = f"{base_name}.{lang}.vtt"
            out_path = Path(out_dir) / out_name
            result = subprocess.run(
                [self.ffmpeg, '-y', '-i', str(src), '-map', f'0:{index}', str(out_path)],
                capture_output=True, timeout=300,
            )
            if result.returncode == 0 and out_path.exists():
                subs[lang] = out_name
            else:
                out_path.unlink(missing_ok=True)
        return subs

    # Codecs directement lisibles par le <video> de Chromium (conteneur mp4).
    WEB_VIDEO = {'h264'}
    WEB_AUDIO = {'aac', 'mp3'}

    def probe_streams(self, src):
        """Retourne {vcodec, acodec, width} de la première vidéo/audio."""
        try:
            out = subprocess.run(
                [self.ffprobe, '-v', 'error',
                 '-show_entries', 'stream=codec_type,codec_name,width',
                 '-of', 'json', str(src)],
                capture_output=True, text=True, timeout=30,
            ).stdout
            streams = json.loads(out).get('streams', [])
        except (json.JSONDecodeError, subprocess.SubprocessError, OSError):
            return {}
        info = {}
        for s in streams:
            if s.get('codec_type') == 'video' and 'vcodec' not in info:
                info['vcodec'] = s.get('codec_name')
                info['width'] = s.get('width')
            elif s.get('codec_type') == 'audio' and 'acodec' not in info:
                info['acodec'] = s.get('codec_name')
        return info

    def needs_reencode(self, src):
        """True si le fichier n'est pas directement lisible (vidéo OU audio)."""
        return self.plan(src) != 'remux'

    def plan(self, src):
        """
        Stratégie de préparation, du moins au plus coûteux :
          'remux' — H.264 + AAC/MP3 : simple copie des flux (instantané).
          'audio' — H.264 mais audio AC3/DTS… : copie vidéo + ré-encode AUDIO
                    seul (rapide ; évite le ré-encodage vidéo, le vrai goulot).
          'full'  — vidéo non web (HEVC, AVI, MPEG-2…) : ré-encodage complet.
        La résolution n'est PAS un critère : Chromium met à l'échelle à l'affichage.
        """
        info = self.probe_streams(src)
        video_ok = info.get('vcodec') in self.WEB_VIDEO
        audio_ok = info.get('acodec') in self.WEB_AUDIO
        if video_ok and audio_ok:
            return 'remux'
        if video_ok:
            return 'audio'
        return 'full'

    def remux(self, src, dst, progress_cb=None):
        """Copie les flux vers un mp4 web (rapide, sans ré-encodage) + faststart."""
        dst = Path(dst)
        tmp_dst = dst.with_suffix('.tmp.mp4')
        cmd = [
            self.ffmpeg, '-y', '-i', str(src),
            # Toutes les pistes audio conservées (multi-langues) ; sous-titres
            # extraits séparément en .vtt.
            '-map', '0:V:0', '-map', '0:a?', '-sn',
            '-c', 'copy', '-movflags', '+faststart',
            '-loglevel', 'error', str(tmp_dst),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            tmp_dst.unlink(missing_ok=True)
            raise RuntimeError(f"remux échoué : {result.stderr[-300:]}")
        os.replace(tmp_dst, dst)
        if progress_cb:
            progress_cb(1.0)

    def transcode(self, src, dst, progress_cb=None):
        """Ré-encodage vidéo complet (H.264/AAC 720w). Bloquant."""
        self._encode(src, dst, self.RECIPE, progress_cb)

    def transcode_audio_only(self, src, dst, progress_cb=None):
        """Copie la vidéo (déjà web) et ne ré-encode QUE l'audio. Rapide."""
        self._encode(src, dst, self.RECIPE_AUDIO_ONLY, progress_cb)

    def _encode(self, src, dst, recipe, progress_cb=None):
        """
        Lance ffmpeg avec `recipe` (args de sortie) et suit la progression.
        Bloquant ; `progress_cb(ratio)` reçoit l'avancement 0..1.
        Lève RuntimeError en cas d'échec ffmpeg.
        """
        duration = self.probe_duration(src)

        # Sortie vers un .tmp.mp4 renommé à la fin : /movies-library ne verra
        # jamais un fichier à moitié écrit.
        dst = Path(dst)
        tmp_dst = dst.with_suffix('.tmp.mp4')

        cmd = [
            self.ffmpeg, '-y', '-i', str(src),
            # Mapping explicite : 1re vidéo réelle (V majuscule = hors image de
            # couverture), TOUTES les pistes audio (multi-langues), aucun
            # sous-titre muxé (ils sont extraits séparément en .vtt).
            '-map', '0:V:0', '-map', '0:a?', '-sn',
            *recipe,
            '-progress', 'pipe:1', '-nostats', '-loglevel', 'error',
            str(tmp_dst),
        ]

        self.process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            # ffmpeg -progress écrit des lignes clé=valeur ; out_time_ms est en
            # microsecondes malgré son nom.
            for line in self.process.stdout:
                m = re.match(r'out_time_ms=(\d+)', line.strip())
                if m and duration > 0 and progress_cb:
                    ratio = min(1.0, int(m.group(1)) / 1_000_000 / duration)
                    progress_cb(ratio)

            self.process.wait()
            if self.process.returncode != 0:
                err = self.process.stderr.read()[-500:]
                raise RuntimeError(f"ffmpeg a échoué ({self.process.returncode}): {err}")

            os.replace(tmp_dst, dst)
            if progress_cb:
                progress_cb(1.0)
        finally:
            tmp_dst.unlink(missing_ok=True)
            self.process = None

    def cancel(self):
        """Tue le ffmpeg en cours (si présent)."""
        if self.process and self.process.poll() is None:
            self.process.kill()


class Torrent:
    """
    Téléchargement d'un magnet via libtorrent, dans un dossier de staging.

    Bloquant : download() tourne jusqu'à complétion et renvoie le chemin du plus
    gros fichier vidéo. La progression remonte via callback. Les données de
    reprise (fast-resume) sont sur disque : un torrent interrompu par un reboot
    reprend là où il en était (libtorrent revérifie les pièces déjà présentes).
    """

    def __init__(self, downloads_dir):
        self.downloads_dir = Path(downloads_dir)
        self.session = None
        self.handle = None
        self._cancelled = False

    def available(self):
        return lt is not None

    def _ensure_session(self):
        if self.session is None:
            # Ports d'écoute + DHT pour trouver des pairs sans tracker central.
            self.session = lt.session({
                'listen_interfaces': '0.0.0.0:6881,[::]:6881',
                'enable_dht': True,
                'enable_lsd': True,   # découverte de pairs sur le réseau local
                'user_agent': 'tv-app/1.0',
            })

    def cancel(self):
        self._cancelled = True

    def download(self, magnet, progress_cb=None, poll=1.0):
        """
        Télécharge `magnet` et renvoie le Path du plus gros fichier vidéo.
        Lève RuntimeError si annulé, libtorrent absent, ou aucune vidéo trouvée.
        """
        if lt is None:
            raise RuntimeError("libtorrent non disponible (apt install python3-libtorrent)")

        self._cancelled = False
        self._ensure_session()
        self.downloads_dir.mkdir(parents=True, exist_ok=True)

        params = lt.parse_magnet_uri(magnet)
        params.save_path = str(self.downloads_dir)
        self.handle = self.session.add_torrent(params)
        h = self.handle

        # 1) Récupération des métadonnées (liste des fichiers) via DHT/pairs
        meta_deadline = time.monotonic() + 120
        while not h.status().has_metadata:
            if self._cancelled:
                self._remove()
                raise RuntimeError("Annulé")
            if time.monotonic() > meta_deadline:
                self._remove()
                raise RuntimeError("Métadonnées introuvables (magnet mort ?)")
            time.sleep(0.5)

        # 2) Téléchargement effectif
        while True:
            s = h.status()
            if self._cancelled:
                self._remove()
                raise RuntimeError("Annulé")
            if progress_cb:
                progress_cb(min(1.0, s.progress))
            # is_finished : toutes les pièces voulues sont là
            if getattr(s, 'is_finished', False) or s.progress >= 1.0:
                break
            time.sleep(poll)

        video = self._largest_video()
        # On garde le seeding coupé (on ne re-partage pas) : retire le torrent
        # de la session mais conserve les fichiers sur disque.
        self._remove(delete_files=False)
        if not video:
            raise RuntimeError("Aucun fichier vidéo dans le torrent")
        return video

    def _largest_video(self):
        """Chemin absolu du plus gros fichier vidéo téléchargé."""
        ti = self.handle.torrent_file()
        if ti is None:
            return None
        files = ti.files()
        best, best_size = None, -1
        for i in range(files.num_files()):
            path = files.file_path(i)
            size = files.file_size(i)
            if Path(path).suffix.lower() in VIDEO_EXTS and size > best_size:
                best, best_size = path, size
        return self.downloads_dir / best if best else None

    def _remove(self, delete_files=True):
        if self.session and self.handle:
            try:
                flags = lt.session.delete_files if delete_files else 0
                self.session.remove_torrent(self.handle, flags)
            except Exception:
                pass
            self.handle = None


class JobWorker:
    """
    File de travaux à un seul worker (le mini-PC ne supporte pas plusieurs
    transcodages simultanés). Chaque job = l'id d'une entrée de la Library ;
    l'état (status/progress/error) vit sur disque dans library.json, ce qui
    permet la reprise après un redémarrage (killall python3 au boot).

    Chaîne complète d'un job magnet : download (torrent) → sous-titres →
    transcodage → ready. Un job "fichier local" saute l'étape torrent.
    `subtitles_fetcher` (optionnel) est injecté par api.py (OpenSubtitles).
    """

    def __init__(self, library, movies_dir, downloads_dir, subtitles_fetcher=None):
        self.library = library
        self.movies_dir = Path(movies_dir)
        self.downloads_dir = Path(downloads_dir)
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        self.transcoder = Transcoder()
        self.torrent = Torrent(downloads_dir)
        self.subtitles_fetcher = subtitles_fetcher
        self.queue = queue.Queue()
        self.current_id = None
        self.cancelled = set()  # ids annulés (jobs en attente ou en cours)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    # ----- API -----

    def enqueue(self, movie_id):
        self.cancelled.discard(movie_id)
        self.queue.put(movie_id)

    def cancel(self, movie_id):
        """Annule un job (en attente ou en cours)."""
        self.cancelled.add(movie_id)
        if movie_id == self.current_id:
            self.transcoder.cancel()
            self.torrent.cancel()
        self.library.patch(movie_id, {"status": "error", "error": "Annulé"})

    def resume_pending(self):
        """
        À appeler au démarrage : re-enfile les jobs interrompus par un reboot.
        Un transcodage repart de zéro (pas de reprise partielle possible).
        """
        for movie_id, entry in self.library.all().items():
            if entry.get('status') in ('queued', 'transcoding', 'downloading', 'fetching-subs'):
                print(f"[Worker] Reprise du job interrompu : {movie_id}")
                self.library.patch(movie_id, {"status": "queued"})
                self.enqueue(movie_id)

    def active_jobs(self):
        """Snapshot léger pour le polling /movies/status."""
        jobs = {}
        for movie_id, entry in self.library.all().items():
            if entry.get('status') not in ('ready',):
                jobs[movie_id] = {
                    "title": entry.get('title'),
                    "status": entry.get('status'),
                    "progress": entry.get('progress', {}),
                    "error": entry.get('error'),
                }
        return jobs

    # ----- boucle worker -----

    def _run(self):
        while True:
            movie_id = self.queue.get()
            if movie_id in self.cancelled:
                continue
            entry = self.library.get(movie_id)
            if not entry:
                continue
            self.current_id = movie_id
            try:
                self._process(movie_id, entry)
            except Exception as err:  # le worker ne doit jamais mourir
                print(f"[Worker] Job {movie_id} en échec : {err}")
                self.library.patch(movie_id, {"status": "error", "error": str(err)})
            finally:
                self.current_id = None

    def _progress_writer(self, movie_id, entry, key):
        """Callback de progression throttlé (écrit library.json ~toutes les 2s)."""
        last = {'t': 0.0}

        def cb(ratio):
            now = time.monotonic()
            if now - last['t'] >= 2.0 or ratio >= 1.0:
                last['t'] = now
                cur = self.library.get(movie_id) or entry
                self.library.patch(movie_id, {
                    "progress": {**cur.get('progress', {}), key: round(ratio, 3)}
                })
        return cb

    def _process(self, movie_id, entry):
        staging = None  # fichier téléchargé à nettoyer en fin de job

        # --- 1. Source : torrent (magnet) ou fichier local ---
        if entry.get('magnet'):
            staged = entry.get('stagingFile')
            if staged and Path(staged).exists():
                # Déjà téléchargé (job repris en cours de transcodage) : on saute
                # l'étape torrent et on réutilise le fichier présent.
                src = Path(staged)
                staging = src
            else:
                self.library.patch(movie_id, {"status": "downloading", "error": None})
                src = self.torrent.download(
                    entry['magnet'],
                    progress_cb=self._progress_writer(movie_id, entry, 'download'),
                )
                staging = src
                self.library.patch(movie_id, {"stagingFile": str(src)})
        else:
            src = entry.get('localSource')
            if not src:
                raise RuntimeError("Aucune source à traiter (ni magnet ni localSource)")
            src = Path(src)
            if not src.is_absolute():
                src = self.movies_dir / src
        if not Path(src).exists():
            raise RuntimeError(f"Fichier source introuvable : {src}")

        if movie_id in self.cancelled:
            return

        # --- 2. Sous-titres (ordre de repli) ---
        # a) embarqués du mkv : même montage que la vidéo → synchro parfaite.
        # b) langues manquantes : OpenSubtitles calé sur le release (moviehash).
        # c) resynchro auto sur l'audio (ffsubsync, best-effort) — dans fetch().
        self.library.patch(movie_id, {"status": "fetching-subs"})
        subs = dict(self.transcoder.extract_subtitles(src, self.movies_dir, movie_id))
        missing = [lang for lang in ('fr', 'en') if lang not in subs]
        if missing and self.subtitles_fetcher:
            try:
                external = self.subtitles_fetcher.fetch(
                    imdb_id=entry.get('imdbId'), tmdb_id=entry.get('tmdbId'),
                    title=entry.get('title'), year=entry.get('year'),
                    out_dir=self.movies_dir, base_name=movie_id,
                    video_path=src, want_langs=missing,
                )
                subs.update(external)
            except Exception as err:  # pas bloquant : on continue sans sous-titres
                print(f"[Worker] Sous-titres indisponibles pour {movie_id} : {err}")

        # --- 3. Préparation vidéo : copie, audio-only ou ré-encodage complet ---
        self.library.patch(movie_id, {"status": "transcoding", "error": None})
        dst = self.movies_dir / entry['file']
        cb = self._progress_writer(movie_id, entry, 'transcode')
        plan = self.transcoder.plan(src)
        if plan == 'remux':
            # Déjà H.264/AAC (ex. fichiers YIFY) : simple copie des flux, instantané
            print(f"[Worker] {movie_id} déjà web-compatible : remux sans ré-encodage")
            self.transcoder.remux(src, dst, cb)
        elif plan == 'audio':
            # H.264 + audio AC3/DTS… : on copie la vidéo, on convertit l'audio seul
            print(f"[Worker] {movie_id} vidéo OK, audio à convertir : ré-encodage audio seul")
            self.transcoder.transcode_audio_only(src, dst, cb)
        else:
            # HEVC, AVI, MPEG-2… : ré-encodage vidéo complet (lent)
            print(f"[Worker] {movie_id} vidéo à ré-encoder (complet)")
            self.transcoder.transcode(src, dst, cb)

        if movie_id in self.cancelled:
            dst.unlink(missing_ok=True)
            return

        # --- 4. Finalisation ---
        duration = self.transcoder.probe_duration(dst)
        audio_tracks = self.transcoder.probe_audio_streams(dst)
        self.library.patch(movie_id, {
            "status": "ready",
            "subtitles": {**entry.get('subtitles', {}), **subs},
            "duration": duration,
            "audioTracks": audio_tracks,
            "error": None,
        })

        # Nettoyage du staging torrent (on ne re-partage pas)
        if staging:
            self._cleanup_staging(staging)
        print(f"[Worker] {movie_id} prêt ({dst.name}, {round(duration)}s)")

    def _cleanup_staging(self, video_path):
        """Supprime le fichier/dossier téléchargé une fois transcodé."""
        try:
            video_path = Path(video_path)
            # Si le torrent a créé un sous-dossier dédié, le retirer entièrement.
            parent = video_path.parent
            if parent != self.downloads_dir and parent.is_dir():
                shutil.rmtree(parent, ignore_errors=True)
            else:
                video_path.unlink(missing_ok=True)
        except OSError as err:
            print(f"[Worker] Nettoyage staging échoué : {err}")
