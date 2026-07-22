from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import json
import os
from pathlib import Path
import requests

import re
import socket
import subprocess
import threading
import time
from urllib.parse import urlparse

from movie_pipeline import Library, JobWorker, atomic_write_json
from movie_sources import Indexer, Tmdb, Subtitles, load_secrets, clean_torrent_title
from movie_series import SeriesManager
from movie_advisor import (
    AdvisorError, Advisor, Blacklist, Gemini, OpenAICompatible, clip_summary,
)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})  # Allow all origins for all routes

# ============ CONFIGURATION ============
# Chemins unifiés vers les dossiers créés en dehors du git (parent du dossier)

# Créer le dossier tv_data en dehors du git si nécessaire
def get_data_dir():
    """
    Retourne le chemin du dossier tv_data créé en dehors du dossier du git.
    Le dossier est situé dans le parent du dossier tv_app.
    """
    # Chemin vers le parent du dossier tv_app
    parent_dir = Path(__file__).parent.parent
    data_dir = parent_dir / 'tv_data'
    data_dir.mkdir(exist_ok=True)
    return str(data_dir)

# Obtenir le dossier movies (également en dehors du git)
def get_movies_dir():
    """
    Retourne le chemin du dossier movies créé en dehors du dossier du git.
    Le dossier est situé dans le parent du dossier tv_app.
    """
    parent_dir = Path(__file__).parent.parent
    movies_dir = parent_dir / 'movies'
    movies_dir.mkdir(exist_ok=True)
    return str(movies_dir)

DATA_DIR = get_data_dir()
MOVIES_DIR = get_movies_dir()
POSTERS_DIR = os.path.join(DATA_DIR, 'posters')
SAVE_FILE = os.path.join(DATA_DIR, 'progression.json')
ALARM_FILE = os.path.join(DATA_DIR, 'alarm.json')
TV_CONTROL_URL = 'http://192.168.1.19/rpc/Switch.Set'

# Catalogue des films (source unique : tv_data/library.json)
library = Library(DATA_DIR, POSTERS_DIR)

# Sources externes (clés API + indexeurs dans tv_data/secrets.json, hors git)
secrets = load_secrets(DATA_DIR)
indexer = Indexer(secrets.get('indexers'))
tmdb = Tmdb(secrets.get('tmdb', {}).get('apiKey'))


# --- Filet de secours Jackett -------------------------------------------------
# Le service systemd (jackett.service, Restart=always) relance Jackett sur crash,
# mais il peut y avoir une fenêtre où il ne répond pas. Avant chaque recherche,
# on vérifie le port ; s'il est fermé, on demande le (re)démarrage du service et
# on attend brièvement qu'il réponde — sinon la recherche renverrait 0 résultat
# instantané (le symptôme exact rencontré).

def _indexer_host_port():
    """(host, port) du 1er indexeur torznab local, défaut 127.0.0.1:9117."""
    for cfg in (secrets.get('indexers') or []):
        if cfg.get('type') == 'torznab' and cfg.get('url'):
            u = urlparse(cfg['url'])
            return (u.hostname or '127.0.0.1', u.port or 9117)
    return ('127.0.0.1', 9117)


_JACKETT_HOST, _JACKETT_PORT = _indexer_host_port()
_jackett_lock = threading.Lock()


def _port_open(host, port, timeout=1.5):
    try:
        with socket.create_connection((host, port), timeout):
            return True
    except OSError:
        return False


def _kick_jackett():
    """Demande le démarrage de Jackett : service systemd, repli sur le launcher."""
    env = dict(os.environ)
    env.setdefault('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')
    try:
        r = subprocess.run(['systemctl', '--user', 'start', 'jackett.service'],
                           capture_output=True, timeout=10, env=env)
        if r.returncode == 0:
            return
    except (OSError, subprocess.SubprocessError):
        pass
    # Repli si systemd --user indisponible : lancer directement le launcher.
    try:
        subprocess.Popen(['/home/tv/Jackett/jackett_launcher.sh'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         stdin=subprocess.DEVNULL, start_new_session=True)
    except OSError as err:
        print(f"[Jackett] relance impossible : {err}")


def ensure_indexer(wait=12):
    """Vrai si l'indexeur répond (après relance éventuelle). Rapide s'il est up."""
    if not indexer.available():
        return False
    if _port_open(_JACKETT_HOST, _JACKETT_PORT):
        return True
    with _jackett_lock:  # une seule relance à la fois (recherches concurrentes)
        if _port_open(_JACKETT_HOST, _JACKETT_PORT):
            return True
        print(f"[Jackett] {_JACKETT_HOST}:{_JACKETT_PORT} injoignable → relance", flush=True)
        _kick_jackett()
        deadline = time.time() + wait
        while time.time() < deadline:
            time.sleep(1)
            if _port_open(_JACKETT_HOST, _JACKETT_PORT):
                print("[Jackett] de nouveau en ligne", flush=True)
                return True
        print("[Jackett] toujours injoignable après relance", flush=True)
        return False
_os = secrets.get('opensubtitles', {})
subtitles = Subtitles(_os.get('apiKey'), _os.get('username'), _os.get('password'))

# Movie Advisor : chaîne de fournisseurs essayés dans l'ordre (le 1er qui
# répond gagne), + films écartés via « Forget ». Un fournisseur en panne/quota
# laisse la place au suivant → filet quand une IA gratuite est indisponible.
_gem = secrets.get('gemini', {})
_or = secrets.get('openRouter', {})
# Gemini en primaire (gratuit et fiable), OpenRouter en repli (modèle gratuit ;
# json_mode off car ces modèles ne gèrent pas tous le JSON natif). Fallbacks
# génériques supplémentaires possibles via secrets["advisorFallbacks"].
_providers = [
    Gemini(_gem.get('apiKey'), _gem.get('model')),
    OpenAICompatible('OpenRouter', 'https://openrouter.ai/api/v1', _or.get('apiKey'),
                     _or.get('model') or 'meta-llama/llama-3.3-70b-instruct:free',
                     json_mode=False),
]
for _fb in secrets.get('advisorFallbacks') or []:
    _providers.append(OpenAICompatible(
        _fb.get('name'), _fb.get('baseUrl'), _fb.get('apiKey'),
        _fb.get('model'), _fb.get('jsonMode', True)))
advisor = Advisor(_providers)
blacklist = Blacklist(DATA_DIR)

# Worker de téléchargement/transcodage (1 job à la fois) + reprise post-reboot
DOWNLOADS_DIR = os.path.join(DATA_DIR, 'downloads')
worker = JobWorker(library, MOVIES_DIR, DOWNLOADS_DIR, subtitles_fetcher=subtitles)
worker.resume_pending()


def _backfill_overviews():
    """
    Complète en arrière-plan le synopsis des films déjà en bibliothèque (ceux
    téléchargés avant le stockage de l'overview). Un seul passage au démarrage,
    ne patche que sur succès → les films sans synopsis TMDB retentent au prochain
    lancement (coût négligeable), pas de faux « vide » définitif.
    """
    if not tmdb.available():
        return
    for movie_id, entry in library.all().items():
        # Films seulement : les séries/épisodes ont un id TMDB /tv (404 sur /movie).
        if entry.get('type') not in (None, 'movie'):
            continue
        if entry.get('overview') or not entry.get('tmdbId'):
            continue
        ov = tmdb.overview(entry['tmdbId'])
        if ov:
            library.patch(movie_id, {"overview": ov})
            print(f"[Backfill] Synopsis ajouté : {entry.get('title')}")


threading.Thread(target=_backfill_overviews, daemon=True).start()

print(f"[TV App] Indexeurs: {len(secrets.get('indexers') or [])} | "
      f"TMDB: {'oui' if tmdb.available() else 'non'} | "
      f"OpenSubtitles: {'oui' if subtitles.available() else 'non'} | "
      f"Advisor: {', '.join(advisor.names()) or 'non'}")

print(f"[TV App] Data directory: {DATA_DIR}")
print(f"[TV App] Movies directory: {MOVIES_DIR}")
print(f"[TV App] Posters directory: {POSTERS_DIR}")
print(f"[TV App] TV Control URL: {TV_CONTROL_URL}")

# ============ ENDPOINTS ============

# --- CHARGER LA SAUVEGARDE ---
@app.route('/load', methods=['GET'])
def load_progress():
    if not os.path.exists(SAVE_FILE):
        return jsonify({}) # Retourne vide si pas de fichier
    try:
        with open(SAVE_FILE, 'r') as f:
            data = json.load(f)
        return jsonify(data)
    except:
        return jsonify({})

# --- SAUVEGARDER LA PROGRESSION ---
@app.route('/save', methods=['POST'])
def save_progress():
    data = request.json

    # Refuse une sauvegarde vide si une progression existe déjà : dernier filet
    # de sécurité contre l'écrasement du fichier par un client mal initialisé.
    if not data and os.path.exists(SAVE_FILE) and os.path.getsize(SAVE_FILE) > 2:
        print("[Save] Refus d'écraser la progression existante avec un état vide")
        return jsonify({"status": "rejected", "reason": "empty payload"}), 409

    os.makedirs(os.path.dirname(SAVE_FILE), exist_ok=True)
    # Écriture atomique (tmp + rename) : pas de fichier tronqué en cas de coupure
    atomic_write_json(SAVE_FILE, data)
    return jsonify({"status": "ok"})

# --- BIBLIOTHÈQUE DE FILMS ---
# library.json est désormais la source unique pour les films : métadonnées,
# progression de lecture et flag vu/pas-vu (remplace movies_progress.json).

def _reject_traversal(name):
    """Retourne True si `name` tente une sortie de répertoire."""
    return '..' in name or '/' in name or '\\' in name


@app.route('/movies/library', methods=['GET'])
def get_library():
    """Retourne le catalogue complet {id: entry} (données de la grille).
    Enrichit chaque entrée avec `fileSize` (octets du fichier transcodé), calculé
    à la volée pour l'affichage « 2.1 GB » du volet détail."""
    data = library.all()
    for entry in data.values():
        entry['fileSize'] = None
        fname = entry.get('file')
        if fname and not _reject_traversal(fname):
            path = Path(MOVIES_DIR) / fname
            try:
                if path.exists():
                    entry['fileSize'] = path.stat().st_size
            except OSError:
                pass
    return jsonify(data)


@app.route('/movies/library', methods=['POST'])
def patch_library():
    """
    Met à jour partiellement une entrée (progression, vu, etc.).
    Body attendu : {"id": "<slug>", "fields": {"currentTime": ..., "duration": ...}}
    """
    data = request.json or {}
    movie_id = data.get('id')
    fields = data.get('fields', {})
    if not movie_id:
        return jsonify({"error": "Missing id"}), 400

    entry = library.patch(movie_id, fields)
    if entry is None:
        return jsonify({"error": "Unknown movie id"}), 404
    return jsonify({"status": "ok", "entry": entry})


@app.route('/movies/delete', methods=['POST'])
def delete_movie():
    """Supprime un film : annule le job éventuel, retire l'entrée + les fichiers
    dérivés (vidéo, affiche, sous-titres .vtt). Ne touche jamais rien hors des
    dossiers dédiés (gardes anti-traversal)."""
    data = request.json or {}
    movie_id = data.get('id')
    if not movie_id:
        return jsonify({"error": "Missing id"}), 400
    entry = library.get(movie_id)
    if entry is None:
        return jsonify({"error": "Unknown movie id"}), 404

    # Annule d'abord un téléchargement/transcodage en cours pour ce film.
    if entry.get('status') in ('queued', 'downloading', 'fetching-subs', 'transcoding'):
        worker.cancel(movie_id)

    def _safe_unlink(directory, name):
        if not name or _reject_traversal(name):
            return
        path = Path(directory) / name
        try:
            if path.exists():
                path.unlink()
        except OSError as err:
            print(f"[Delete] {path}: {err}")

    _safe_unlink(MOVIES_DIR, entry.get('file'))
    _safe_unlink(POSTERS_DIR, entry.get('poster'))
    for sub_name in (entry.get('subtitles') or {}).values():
        _safe_unlink(MOVIES_DIR, sub_name)

    # Série : supprime aussi ses épisodes (fichiers + entrées) et ses jobs pack.
    if entry.get('type') == 'series':
        for child_id, child in list(library.all().items()):
            if child.get('showId') != movie_id:
                continue
            if child.get('status') in ('queued', 'downloading', 'fetching-subs', 'transcoding'):
                worker.cancel(child_id)
            _safe_unlink(MOVIES_DIR, child.get('file'))
            _safe_unlink(POSTERS_DIR, child.get('poster'))
            for sub_name in (child.get('subtitles') or {}).values():
                _safe_unlink(MOVIES_DIR, sub_name)
            library.delete(child_id)

    library.delete(movie_id)
    return jsonify({"status": "deleted", "id": movie_id})


def _slugify(title, year=None):
    """'The Matrix', 1999 -> 'the-matrix-1999' (id + noms de fichiers)."""
    slug = re.sub(r'[^a-z0-9]+', '-', str(title).lower()).strip('-') or 'film'
    return f"{slug}-{year}" if year else slug


# Orchestrateur séries (TMDB TV + indexeur + worker). Branche on_pack_done pour
# le repli épisode-unique. Dépend de _slugify, donc instancié ici.
series = SeriesManager(library, tmdb, indexer, worker, _slugify, Path(POSTERS_DIR))
# Même filet Jackett pour les téléchargements de séries (recherches en tâche de fond).
series.ensure_indexer = ensure_indexer


def _recheck_loop():
    """Re-check périodique des séries en cours de diffusion (nouveaux épisodes)."""
    while True:
        try:
            series.recheck_airing()
        except Exception as err:
            print(f"[Series] recheck échec : {err}")
        time.sleep(12 * 3600)


threading.Thread(target=_recheck_loop, daemon=True).start()


# --- MOVIE ADVISOR : RECOMMANDATIONS IA ---

@app.route('/advisor/recommend', methods=['POST'])
def advisor_recommend():
    """
    Rend 3 recommandations selon les critères choisis.
    Body : {"criteria": {"mood": "Mystery", "era": "90s", ...}}

    Les exclusions sont montées ici, pas côté client : films écartés via
    « Forget » + films déjà dans la bibliothèque (le bouton d'une reco sert à
    la télécharger, donc en proposer une déjà possédée n'a aucun intérêt).
    """
    if not advisor.available():
        return jsonify({"error": "Advisor not configured (no AI API key)"}), 503

    body = request.json or {}
    criteria = body.get('criteria') or {}
    keywords = body.get('keywords') or ''
    kind = 'series' if body.get('kind') == 'series' else 'movie'

    owned = [e.get('title') for e in library.all().values() if e.get('title')]
    excluded = sorted(set(blacklist.titles()) | set(owned))

    try:
        recs = advisor.recommend(criteria, excluded, keywords, kind)
    except AdvisorError as err:
        # Le message vient de Google (quota, clé invalide…) : il est montrable
        # tel quel et évite de faire deviner la cause depuis l'écran.
        return jsonify({"error": str(err)}), 502

    # Enrichissement TMDB : l'affiche est une URL distante. /poster/<id> ne peut
    # pas servir ces films (il résout le fichier via la bibliothèque, donc 404
    # pour un film non possédé) — même mécanisme que les résultats de recherche.
    out = []
    for rec in recs:
        title = rec.get('title')
        year = rec.get('year')
        # Match TMDB en fr-FR (titre de Gemini en français → bon film/série),
        # puis titre anglais par id pour la recherche torrent. Endpoints TV si série.
        if kind == 'series':
            meta = tmdb.search_tv(title, year) if tmdb.available() else None
            english = tmdb.english_tv_title(meta['tmdbId']) if meta else None
        else:
            meta = tmdb.search(title, year) if tmdb.available() else None
            english = tmdb.english_title(meta['tmdbId']) if meta else None
        query = english or (meta or {}).get('originalTitle') or title
        out.append({
            "id": _slugify(title, year),
            "title": title,   # affiché (français, de l'IA)
            "query": query,   # recherche torrent (anglais)
            "kind": kind,
            "year": year,
            "posterUrl": (meta or {}).get('posterUrl'),
            "summary": clip_summary(rec.get('description')),
        })
    return jsonify(out)


@app.route('/advisor/forget', methods=['POST'])
def advisor_forget():
    """
    Écarte définitivement un film des recommandations.
    Body : {"id": "<slug>", "title": "...", "year": 1999}
    """
    data = request.json or {}
    title = data.get('title')
    if not title:
        return jsonify({"error": "Missing title"}), 400

    year = data.get('year')
    entry = {
        "id": data.get('id') or _slugify(title, year),
        "title": title,
        "year": year,
        "addedAt": int(time.time()),
    }
    blacklist.add(entry)
    print(f"[Advisor] Écarté : {title} ({year})")
    return jsonify({"status": "ok", "entry": entry})


@app.route('/movies/search', methods=['POST'])
def movies_search():
    """
    Recherche un film : interroge les indexeurs (repli IP) puis enrichit avec
    TMDB (affiche + année). Body : {"query": "titre"}.
    Retourne : [{title, year, tmdbId, posterUrl, imdbId, torrents:[...]}]
    """
    query = (request.json or {}).get('query', '').strip()
    if not query:
        return jsonify({"error": "query vide"}), 400
    if not indexer.available():
        return jsonify({"error": "Aucun indexeur configuré (tv_data/secrets.json)"}), 503
    ensure_indexer()  # relance Jackett s'il est tombé, avant d'interroger

    found = indexer.search(query)

    results = []
    for movie in found:
        if not movie.get('torrents'):
            continue  # rien de téléchargeable

        # Nettoie le nom de torrent bruité pour fiabiliser le match TMDB
        clean_title, parsed_year = clean_torrent_title(movie['title'])
        year_hint = movie.get('year') or parsed_year
        meta = tmdb.search(clean_title, year_hint) if (tmdb.available() and clean_title) else None

        results.append({
            # Titre/année propres même sans TMDB (utile pour l'affiche ET les sous-titres)
            "title": (meta or {}).get('title') or clean_title or movie['title'],
            "year": (meta or {}).get('year') or year_hint,
            "tmdbId": (meta or {}).get('tmdbId'),
            "imdbId": movie.get('imdbId'),
            "posterUrl": (meta or {}).get('posterUrl') or movie.get('cover'),
            "overview": (meta or {}).get('overview'),
            "torrents": movie['torrents'],
        })
    return jsonify(results)


@app.route('/movies/download', methods=['POST'])
def movies_download():
    """
    Crée un job et le met en file. Deux sources possibles :
      - torrent : {"magnet": "...", "title": ..., "year": ..., "tmdbId": ...,
                   "imdbId": ..., "posterUrl": ...}
      - fichier local (transcodage seul) : {"localFile": "1.mkv", "title": ...}
    Renvoie l'id immédiatement ; le worker traite en arrière-plan.
    """
    data = request.json or {}
    magnet = data.get('magnet')
    local_file = data.get('localFile')
    title = data.get('title') or local_file
    year = data.get('year')

    if not title:
        return jsonify({"error": "title requis"}), 400
    if not magnet and not local_file:
        return jsonify({"error": "magnet ou localFile requis"}), 400

    if local_file:
        if _reject_traversal(local_file):
            return jsonify({"error": "Invalid filename"}), 400
        if not (Path(MOVIES_DIR) / local_file).exists():
            return jsonify({"error": f"Fichier introuvable : {local_file}"}), 404

    movie_id = _slugify(title, year)
    if library.get(movie_id):
        return jsonify({"error": "Ce film existe déjà", "id": movie_id}), 409

    # Affiche : téléchargée localement pour être servie par /poster/<id>
    poster_name = None
    poster_url = data.get('posterUrl')
    if poster_url:
        poster_name = f"{movie_id}.jpg"
        if not tmdb.download_poster(poster_url, os.path.join(POSTERS_DIR, poster_name)):
            poster_name = None

    entry = {
        "id": movie_id, "title": title, "year": year,
        "tmdbId": data.get('tmdbId'), "imdbId": data.get('imdbId'),
        "overview": data.get('overview'),
        "poster": poster_name, "file": f"{movie_id}.mp4",
        "subtitles": {}, "duration": 0,
        "status": "queued",
        "progress": {"download": 0 if magnet else 1, "transcode": 0},
        "error": None, "magnet": magnet,
        "localSource": local_file,
        "addedAt": int(time.time()),
        "currentTime": 0, "watched": False,
        # Décalage des sous-titres mémorisé PAR LANGUE (ex. {"fr": 0.3, "en": -0.2}).
        "subtitleMode": None, "subtitleOffsets": {},
    }
    library.upsert(entry)
    worker.enqueue(movie_id)
    return jsonify({"status": "queued", "id": movie_id})


@app.route('/movies/status', methods=['GET'])
def movies_status():
    """Snapshot léger des jobs non terminés (polling frontend ~1,5 s)."""
    return jsonify(worker.active_jobs())


@app.route('/movies/disk', methods=['GET'])
def movies_disk():
    """Espace du volume des films — affiché dans l'en-tête de la bibliothèque."""
    st = os.statvfs(MOVIES_DIR)
    return jsonify({
        "freeBytes": st.f_bavail * st.f_frsize,   # dispo pour un utilisateur normal
        "totalBytes": st.f_blocks * st.f_frsize,
    })


@app.route('/movies/cancel', methods=['POST'])
def movies_cancel():
    """Annule un job en attente ou en cours. Body : {"id": "<slug>"}"""
    data = request.json or {}
    movie_id = data.get('id')
    if not movie_id or not library.get(movie_id):
        return jsonify({"error": "Unknown movie id"}), 404
    worker.cancel(movie_id)
    return jsonify({"status": "cancelled", "id": movie_id})


# --- SÉRIES ---

@app.route('/series/search', methods=['POST'])
def series_search():
    """Recherche de séries via TMDB TV. Body : {"query": "..."}."""
    query = (request.json or {}).get('query', '').strip()
    if not query:
        return jsonify({"error": "query vide"}), 400
    if not tmdb.available():
        return jsonify({"error": "TMDB non configuré (tv_data/secrets.json)"}), 503
    return jsonify(tmdb.search_tv_all(query))


@app.route('/series/add', methods=['POST'])
def series_add():
    """Enregistre une série au catalogue. Body : {"tmdbId": 1396}."""
    tmdb_id = (request.json or {}).get('tmdbId')
    if not tmdb_id:
        return jsonify({"error": "tmdbId requis"}), 400
    show = series.add_show(tmdb_id)
    if not show:
        return jsonify({"error": "Série introuvable sur TMDB"}), 404
    return jsonify({"status": "ok", "id": show['id'], "show": show})


@app.route('/series/<show_id>', methods=['GET'])
def series_get(show_id):
    """Entrée série du catalogue (structure des saisons)."""
    show = library.get(show_id)
    if not show or show.get('type') != 'series':
        return jsonify({"error": "Série inconnue"}), 404
    return jsonify(show)


@app.route('/series/<show_id>/season/<int:season>', methods=['GET'])
def series_season(show_id, season):
    """Épisodes d'une saison + état local (missing/downloading/ready/error)."""
    view = series.season_view(show_id, season)
    if view is None:
        return jsonify({"error": "Série inconnue"}), 404
    return jsonify(view)


@app.route('/series/download', methods=['POST'])
def series_download():
    """
    Lance le téléchargement d'un épisode / d'une saison / de la série.
    Body : {"showId": "...", "scope": "episode|season|series", "season"?, "episode"?}.
    Les recherches d'indexeur peuvent être nombreuses (saison/série) → exécutées
    en arrière-plan ; le front suit l'état via /series/<id>/season/<n>.
    """
    data = request.json or {}
    show_id = data.get('showId')
    scope = data.get('scope')
    if not show_id or scope not in ('episode', 'season', 'series'):
        return jsonify({"error": "showId + scope (episode|season|series) requis"}), 400
    if not library.get(show_id):
        return jsonify({"error": "Série inconnue"}), 404
    if not indexer.available():
        return jsonify({"error": "Aucun indexeur configuré (tv_data/secrets.json)"}), 503
    threading.Thread(
        target=series.download_async,
        args=(show_id, scope, data.get('season'), data.get('episode')),
        daemon=True,
    ).start()
    return jsonify({"status": "queued"})


@app.route('/series/recheck', methods=['POST'])
def series_recheck():
    """Force un re-check des séries en cours (arrière-plan)."""
    threading.Thread(target=series.recheck_airing, daemon=True).start()
    return jsonify({"status": "ok"})


# --- SERVIR UN FICHIER VIDÉO ---
@app.route('/get-movie/<filename>', methods=['GET'])
def get_movie(filename):
    """Serve a movie file from the movies directory"""
    try:
        # Security: ensure filename doesn't contain path traversal
        if _reject_traversal(filename):
            return jsonify({"error": "Invalid filename"}), 400

        movie_path = Path(MOVIES_DIR) / filename

        # Check if file exists
        if not movie_path.exists():
            return jsonify({"error": "Movie not found"}), 404

        # Send file with proper streaming support
        return send_file(
            str(movie_path),
            mimetype='video/mp4',
            as_attachment=False
        )
    except Exception as e:
        print(f"[Movies] Error serving {filename}: {e}")
        return jsonify({"error": "Error retrieving movie"}), 500


# --- SERVIR UNE AFFICHE ---
@app.route('/poster/<movie_id>', methods=['GET'])
def get_poster(movie_id):
    """Sert l'affiche tv_data/posters/<id>.jpg d'un film du catalogue."""
    if _reject_traversal(movie_id):
        return jsonify({"error": "Invalid id"}), 400

    entry = library.get(movie_id)
    poster_name = (entry or {}).get('poster') if entry else None
    # Épisode sans affiche propre → retombe sur l'affiche de sa série.
    if entry and not poster_name and entry.get('type') == 'episode' and entry.get('showId'):
        poster_name = (library.get(entry['showId']) or {}).get('poster')
    poster_path = Path(POSTERS_DIR) / poster_name if poster_name else None

    if not poster_path or not poster_path.exists():
        return jsonify({"error": "Poster not found"}), 404
    return send_file(str(poster_path), mimetype='image/jpeg')


# --- SERVIR UN SOUS-TITRE (WebVTT) ---
@app.route('/subtitle/<movie_id>/<lang>', methods=['GET'])
def get_subtitle(movie_id, lang):
    """Sert le fichier .vtt d'une langue donnée pour un film du catalogue."""
    if _reject_traversal(movie_id) or _reject_traversal(lang):
        return jsonify({"error": "Invalid parameters"}), 400

    entry = library.get(movie_id)
    sub_name = (entry or {}).get('subtitles', {}).get(lang) if entry else None
    sub_path = Path(MOVIES_DIR) / sub_name if sub_name else None

    if not sub_path or not sub_path.exists():
        return jsonify({"error": "Subtitle not found"}), 404
    return send_file(str(sub_path), mimetype='text/vtt')

# --- CONTRÔLE TV (PROXY POUR SHELLY) ---
@app.route('/tv-power', methods=['POST'])
def tv_power_control():
    """Proxy pour contrôler la prise Shelly (évite les problèmes CORS)"""
    data = request.json
    on = data.get('on', True)
    
    try:
        # Shelly expects 'true' or 'false' as strings, not 0/1
        on_value = 'true' if on else 'false'
        url = f"{TV_CONTROL_URL}?id=0&on={on_value}"
        print(f"[TV Control] Calling: {url}")
        
        response = requests.get(url, timeout=5)
        response.raise_for_status()
        
        result = response.json()
        print(f"[TV Control] Response: {result}")
        return jsonify(result)
    except requests.exceptions.Timeout:
        return jsonify({"status": "error", "message": "TV device timeout"}), 504
    except Exception as err:
        print(f"[TV Control] Error: {err}")
        return jsonify({"status": "error", "message": str(err)}), 500

# --- CHARGER LES PARAMÈTRES D'ALARME ---
@app.route('/alarm-settings', methods=['GET'])
def load_alarm_settings():
    if not os.path.exists(ALARM_FILE):
        return jsonify({"time": "08:00", "enabled": False})
    try:
        with open(ALARM_FILE, 'r') as f:
            data = json.load(f)
        return jsonify(data)
    except:
        return jsonify({"time": "08:00", "enabled": False})

# --- SAUVEGARDER LES PARAMÈTRES D'ALARME ---
@app.route('/alarm-settings', methods=['POST'])
def save_alarm_settings():
    data = request.json

    os.makedirs(os.path.dirname(ALARM_FILE), exist_ok=True)
    # Écriture atomique (tmp + rename) : pas de fichier tronqué en cas de coupure
    atomic_write_json(ALARM_FILE, data)

    print(f"[Alarm] Settings saved: {data}")
    return jsonify({"status": "ok"})

# --- MÉTÉO (proxy Open-Meteo, gratuit et sans clé) ---
# Tours, France. Open-Meteo ne renvoie pas d'en-tête CORS → on relaie côté
# serveur (le front n'appelle que notre API). Cache pour ne pas marteler.
WEATHER_LAT, WEATHER_LON = 47.39, 0.69
_weather_cache = {"at": 0, "data": None}


# Créneaux de la journée (heure locale) affichés dans la popup de prévisions.
WEATHER_PERIODS = [("Morning", 9), ("Afternoon", 15), ("Evening", 21)]


@app.route('/weather', methods=['GET'])
def weather():
    """
    Météo de Tours. Icône d'en-tête (heure suivante) + prévision du jour pour la
    popup :
      {
        "code": <WMO>, "hour": "14:00", "location": "Tours",
        "day": {"code": <WMO>, "lo": 12, "hi": 24},
        "periods": [{"label": "Morning", "code": <WMO>, "temp": 15}, ...]
      }
    Cache 15 min ; en cas d'échec, dernière valeur connue ou 503.
    """
    now = time.time()
    if _weather_cache["data"] and now - _weather_cache["at"] < 900:
        return jsonify(_weather_cache["data"])

    try:
        resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": WEATHER_LAT, "longitude": WEATHER_LON,
                "hourly": "weather_code,temperature_2m",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min",
                "timezone": "Europe/Paris", "forecast_days": 2,
            },
            timeout=8,
        )
        resp.raise_for_status()
        payload = resp.json()
        hourly = payload["hourly"]
        times, codes, temps = hourly["time"], hourly["weather_code"], hourly["temperature_2m"]

        def at_hour(hour):
            """Index horaire d'aujourd'hui à `hour`h locale (repli sur 0)."""
            stamp = time.strftime(f"%Y-%m-%dT{hour:02d}:00", time.localtime(now))
            return times.index(stamp) if stamp in times else 0

        # Icône d'en-tête : heure locale actuelle + 1.
        target = time.strftime("%Y-%m-%dT%H:00", time.localtime(now + 3600))
        idx = times.index(target) if target in times else 0

        periods = [
            {"label": label, "code": codes[at_hour(h)], "temp": round(temps[at_hour(h)])}
            for label, h in WEATHER_PERIODS
        ]
        daily = payload.get("daily", {})
        day = {
            "code": (daily.get("weather_code") or [codes[idx]])[0],
            "hi": round((daily.get("temperature_2m_max") or [temps[idx]])[0]),
            "lo": round((daily.get("temperature_2m_min") or [temps[idx]])[0]),
        }
        data = {
            "code": codes[idx], "hour": times[idx][11:16], "location": "Tours",
            "day": day, "periods": periods,
        }
    except (requests.RequestException, ValueError, KeyError, IndexError) as err:
        print(f"[Weather] Prévision indisponible : {err}")
        if _weather_cache["data"]:
            return jsonify(_weather_cache["data"])
        return jsonify({"error": "Weather unavailable"}), 503

    _weather_cache.update(at=now, data=data)
    return jsonify(data)


# --- HEALTH CHECK ---
@app.route('/health', methods=['GET'])
def health():
    """Endpoint de santé pour vérifier que l'API fonctionne"""
    return jsonify({
        "status": "ok",
        "version": "2.0",
        "data_dir": DATA_DIR
    })

if __name__ == '__main__':
    # Tourne sur le port 5000
    # 0.0.0.0 pour accepter les connexions depuis n'importe où
    app.run(host='0.0.0.0', port=5000, debug=False)
