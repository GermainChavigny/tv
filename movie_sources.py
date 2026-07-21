"""
Sources externes du volet films : secrets, indexeur de torrents (Jackett via
son API Torznab) et métadonnées TMDB.

Tout ce qui est spécifique à un fournisseur (URL Jackett, clés API) vit dans
tv_data/secrets.json — JAMAIS dans le dépôt git. Jackett agrège les trackers ;
le code ne fait qu'interroger son API. L'usage licite du contenu relève de
l'utilisateur.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests


# ---------------------------------------------------------------------------
# Secrets (clés API + indexeurs), hors git
# ---------------------------------------------------------------------------

SECRETS_TEMPLATE = {
    "tmdb": {"apiKey": ""},
    "opensubtitles": {"apiKey": "", "username": "", "password": ""},
    # Movie Advisor : chaîne de fournisseurs IA essayés dans l'ordre (Gemini,
    # puis OpenRouter, puis fallbacks). Le 1er qui répond gagne ; un fournisseur
    # en panne/quota laisse la place au suivant. Il suffit d'UN fournisseur.
    #   - Gemini : clé gratuite sur https://aistudio.google.com (sans CB).
    #   - OpenRouter : https://openrouter.ai (modèles ":free", quota limité).
    "gemini": {"apiKey": "", "model": "gemini-2.5-flash"},
    "openRouter": {"apiKey": "", "model": "meta-llama/llama-3.3-70b-instruct:free"},
    # Fallbacks génériques compatibles OpenAI (/chat/completions), essayés après
    # les précédents. Ex. Groq (gratuit, rapide) ou xAI/Grok (crédits requis) :
    #   {"name": "Groq", "baseUrl": "https://api.groq.com/openai/v1",
    #    "apiKey": "", "model": "llama-3.3-70b-versatile"},
    #   {"name": "xAI", "baseUrl": "https://api.x.ai/v1",
    #    "apiKey": "", "model": "grok-3"},
    "advisorFallbacks": [],
    "indexers": [
        # Indexeur Torznab (Jackett). Jackett tourne en local (port 9117) et
        # agrège tous les trackers ajoutés dans son tableau de bord.
        # {
        #   "name": "Jackett", "type": "torznab",
        #   "url": "http://127.0.0.1:9117",
        #   "apiKey": "<clé API Jackett>",   # Dashboard Jackett → « API Key »
        #   "indexer": "all",                # "all" = agrégat de tous les trackers
        #   "filter": {"minSeeders": 1, "maxSizeGb": 6}
        # }
    ],
}


def load_secrets(data_dir):
    """
    Charge tv_data/secrets.json. Crée un gabarit vide au premier lancement pour
    que l'utilisateur sache quoi remplir. Retourne toujours un dict exploitable.
    """
    path = Path(data_dir) / "secrets.json"
    if not path.exists():
        try:
            with open(path, "w") as f:
                json.dump(SECRETS_TEMPLATE, f, indent=2)
            print(f"[Secrets] Gabarit créé : {path} (à compléter)")
        except OSError as err:
            print(f"[Secrets] Impossible de créer le gabarit : {err}")
        return dict(SECRETS_TEMPLATE)
    try:
        with open(path) as f:
            data = json.load(f)
        # Complète les clés manquantes sans écraser l'existant
        merged = dict(SECRETS_TEMPLATE)
        merged.update(data)
        return merged
    except (json.JSONDecodeError, OSError) as err:
        print(f"[Secrets] Lecture impossible ({err}), gabarit vide utilisé")
        return dict(SECRETS_TEMPLATE)


# ---------------------------------------------------------------------------
# Indexeur de torrents (Jackett/Torznab)
# ---------------------------------------------------------------------------

# Trackers publics ajoutés aux magnets pour améliorer la résolution des pairs.
DEFAULT_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
]


def _magnet_hash(magnet):
    """Extrait l'info-hash (btih) d'un magnet, en minuscules — clé de dédoublonnage."""
    if not magnet:
        return None
    match = re.search(r"btih:([0-9a-zA-Z]+)", magnet)
    return match.group(1).lower() if match else None


def build_magnet(info_hash, name=None, trackers=DEFAULT_TRACKERS):
    """Construit un lien magnet à partir d'un info-hash et de trackers."""
    magnet = f"magnet:?xt=urn:btih:{info_hash}"
    if name:
        from urllib.parse import quote
        magnet += f"&dn={quote(name)}"
    for tr in trackers:
        from urllib.parse import quote
        magnet += f"&tr={quote(tr)}"
    return magnet


def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _human_size(num_bytes):
    """Formate un nombre d'octets en libellé lisible (fallback si pas fourni)."""
    if not num_bytes:
        return None
    size = float(num_bytes)
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} Po"


def _redact(text, secret):
    """Remplace un secret par « *** » dans un texte destiné aux logs."""
    return text.replace(secret, "***") if secret else text


class Indexer:
    """
    Recherche de torrents de films via un indexeur Torznab (Jackett), qui agrège
    lui-même tous les trackers configurés dans son tableau de bord. Résultats
    normalisés et agrégés par film.
    """

    def __init__(self, indexers):
        self.indexers = indexers or []

    def available(self):
        return bool(self.indexers)

    def search(self, query, limit=20, cat=None):
        """
        Retourne une liste de films/épisodes normalisés :
        [{title, year, imdbId, cover, torrents: [{quality, seeders, size, magnet}]}]
        `cat` force une catégorie Torznab (ex. "5000" = TV) ; sinon celle du cfg.
        """
        results = []
        for cfg in self.indexers:
            try:
                kind = cfg.get("type")
                if kind == "torznab":
                    results.extend(self._search_torznab(cfg, query, limit, cat))
                else:
                    print(f"[Indexer] type inconnu : {kind}")
            except Exception as err:  # un indexeur HS ne casse pas la recherche
                # requests met l'URL COMPLÈTE dans ses exceptions réseau, apiKey
                # comprise : on la masque avant d'écrire quoi que ce soit.
                print(f"[Indexer] {cfg.get('name')} en échec : "
                      f"{_redact(str(err), cfg.get('apiKey'))}")
        return results

    def _search_torznab(self, cfg, query, limit, cat=None):
        """
        Indexeur Torznab (Jackett / Prowlarr). Interroge l'agrégat de tous les
        trackers configurés côté Jackett et normalise la réponse RSS/XML dans le
        format attendu par l'app.

        Config (secrets.json) :
          url      base Jackett, ex. "http://127.0.0.1:9117"
          apiKey   clé API Jackett (onglet Dashboard → « API Key »)
          indexer  id d'indexeur Jackett (défaut "all" = agrégat de tous)
          filter   {minSeeders (déf. 1), maxSizeGb (déf. aucun)}
          cat      catégories Torznab optionnelles (ex. "2000" pour Films)

        Les indexeurs (trackers) eux-mêmes s'ajoutent dans le tableau de bord
        Jackett (http://<box>:9117) — pas ici.
        """
        base = (cfg.get("url") or "http://127.0.0.1:9117").rstrip("/")
        indexer = cfg.get("indexer", "all")
        flt = cfg.get("filter", {})
        min_seeders = flt.get("minSeeders", 1)
        max_bytes = flt.get("maxSizeGb", 0) * (1024 ** 3) if flt.get("maxSizeGb") else None

        url = f"{base}/api/v2.0/indexers/{indexer}/results/torznab/api"
        params = {"apikey": cfg.get("apiKey", ""), "t": "search", "q": query}
        cat = cat or cfg.get("cat")  # argument explicite prioritaire (ex. TV=5000)
        if cat:
            params["cat"] = cat
        resp = requests.get(url, params=params, timeout=cfg.get("timeout", 15))
        resp.raise_for_status()
        root = ET.fromstring(resp.content)

        TZ = "{http://torznab.com/schemas/2015/feed}"
        strict, oversized = [], []
        seen = set()
        for item in root.iter("item"):
            title = (item.findtext("title") or "?").strip()
            attrs = {a.get("name"): a.get("value") for a in item.findall(f"{TZ}attr")}

            # Magnet : magneturl en priorité, sinon <link>/<enclosure> s'ils sont
            # des magnets, sinon reconstruit depuis l'infohash. Un simple lien
            # .torrent HTTP est ignoré (le pipeline attend un magnet).
            magnet = attrs.get("magneturl")
            if not magnet and (item.findtext("link") or "").startswith("magnet:"):
                magnet = item.findtext("link")
            if not magnet:
                enc = item.find("enclosure")
                if enc is not None and (enc.get("url") or "").startswith("magnet:"):
                    magnet = enc.get("url")
            if not magnet and attrs.get("infohash"):
                magnet = build_magnet(attrs["infohash"], title)
            if not magnet:
                continue

            key = _magnet_hash(magnet) or magnet
            if key in seen:
                continue
            seen.add(key)

            seeders = _to_int(attrs.get("seeders"))
            if seeders < min_seeders:
                continue

            size_bytes = _to_int(item.findtext("size") or attrs.get("size"))
            too_big = bool(max_bytes and size_bytes and size_bytes > max_bytes)

            movie = {
                "title": title,
                "year": None,
                "imdbId": attrs.get("imdb") or attrs.get("imdbid"),
                "cover": None,
                "torrents": [{
                    "quality": None,
                    "seeders": seeders,
                    "size": _human_size(size_bytes),
                    "magnet": magnet,
                }],
            }
            (oversized if too_big else strict).append((seeders, movie))

        # On privilégie les sources sous le cap de taille, mais on garde les
        # grosses s'il ne reste sinon plus rien (le transcodage les ramène en 720p).
        scored = strict or oversized
        scored.sort(key=lambda x: x[0], reverse=True)
        return [mv for _, mv in scored[:limit]]


# ---------------------------------------------------------------------------
# Métadonnées TMDB (affiches, année, durée)
# ---------------------------------------------------------------------------

class Tmdb:
    """Recherche de films et affiches via l'API TMDB (clé gratuite requise)."""

    BASE = "https://api.themoviedb.org/3"
    IMG = "https://image.tmdb.org/t/p"

    def __init__(self, api_key):
        self.api_key = api_key or ""

    def available(self):
        return bool(self.api_key)

    def search(self, query, year=None, language="fr-FR"):
        """
        Retourne le meilleur film {tmdbId, title, originalTitle, year, posterUrl,
        overview} ou None. `language` pilote la langue des champs traduits :
        en-US pour obtenir un `title` anglais (utile pour la recherche torrent).
        """
        if not self.api_key:
            return None
        try:
            params = {"api_key": self.api_key, "query": query, "language": language}
            if year:
                params["year"] = year
            resp = requests.get(f"{self.BASE}/search/movie", params=params, timeout=8)
            resp.raise_for_status()
            results = resp.json().get("results", [])
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] recherche échouée : {err}")
            return None
        if not results:
            return None
        m = results[0]
        poster = m.get("poster_path")
        y = (m.get("release_date") or "")[:4]
        return {
            "tmdbId": m.get("id"),
            "title": m.get("title"),
            # Titre original (souvent l'anglais) : meilleur pour la recherche
            # torrent que le titre traduit renvoyé en fr-FR.
            "originalTitle": m.get("original_title") or m.get("title"),
            "year": int(y) if y.isdigit() else year,
            "posterUrl": f"{self.IMG}/w500{poster}" if poster else None,
            "overview": m.get("overview"),
        }

    def english_title(self, tmdb_id):
        """
        Titre anglais d'un film par son id TMDB (best-effort, None si échec).
        Passe par l'id pour ne PAS refausser la correspondance : on cherche le
        film en fr-FR (le titre vient de Gemini en français) puis on lit son
        titre anglais ici — ex. « Les Évadés » → « The Shawshank Redemption ».
        """
        if not self.api_key or not tmdb_id:
            return None
        try:
            resp = requests.get(
                f"{self.BASE}/movie/{tmdb_id}",
                params={"api_key": self.api_key, "language": "en-US"},
                timeout=8,
            )
            resp.raise_for_status()
            return resp.json().get("title")
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] titre anglais indisponible : {err}")
            return None

    def overview(self, tmdb_id, language="fr-FR"):
        """Synopsis d'un film par son id TMDB (best-effort, None si échec)."""
        if not self.api_key or not tmdb_id:
            return None
        try:
            resp = requests.get(
                f"{self.BASE}/movie/{tmdb_id}",
                params={"api_key": self.api_key, "language": language},
                timeout=8,
            )
            resp.raise_for_status()
            return resp.json().get("overview") or None
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] synopsis indisponible : {err}")
            return None

    # --- Séries (TV) : miroir des méthodes films sur les endpoints /tv ---

    def search_tv(self, query, year=None, language="fr-FR"):
        """
        Meilleure série {tmdbId, title, originalTitle, year, posterUrl, overview}
        ou None. Miroir de `search` sur /search/tv (champs name/first_air_date).
        """
        if not self.api_key:
            return None
        try:
            params = {"api_key": self.api_key, "query": query, "language": language}
            if year:
                params["first_air_date_year"] = year
            resp = requests.get(f"{self.BASE}/search/tv", params=params, timeout=8)
            resp.raise_for_status()
            results = resp.json().get("results", [])
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] recherche série échouée : {err}")
            return None
        if not results:
            return None
        return self._tv_summary(results[0])

    def search_tv_all(self, query, language="fr-FR", limit=10):
        """Liste de séries candidates (pour l'écran de recherche)."""
        if not self.api_key:
            return []
        try:
            resp = requests.get(
                f"{self.BASE}/search/tv",
                params={"api_key": self.api_key, "query": query, "language": language},
                timeout=8,
            )
            resp.raise_for_status()
            results = resp.json().get("results", [])
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] recherche série échouée : {err}")
            return []
        return [self._tv_summary(m) for m in results[:limit]]

    def _tv_summary(self, m):
        poster = m.get("poster_path")
        y = (m.get("first_air_date") or "")[:4]
        return {
            "tmdbId": m.get("id"),
            "title": m.get("name"),
            "originalTitle": m.get("original_name") or m.get("name"),
            "year": int(y) if y.isdigit() else None,
            "posterUrl": f"{self.IMG}/w500{poster}" if poster else None,
            "overview": m.get("overview"),
        }

    def english_tv_title(self, tv_id):
        """Titre anglais d'une série par id TMDB (pour la recherche torrent)."""
        if not self.api_key or not tv_id:
            return None
        try:
            resp = requests.get(
                f"{self.BASE}/tv/{tv_id}",
                params={"api_key": self.api_key, "language": "en-US"},
                timeout=8,
            )
            resp.raise_for_status()
            return resp.json().get("name")
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] titre anglais série indisponible : {err}")
            return None

    def tv_details(self, tv_id, language="fr-FR"):
        """
        Détails d'une série : statut (Returning Series/Ended…) et la liste des
        saisons {seasonNumber, episodeCount, name}. La saison 0 (specials) est
        conservée mais l'UI peut la masquer. None si échec.
        """
        if not self.api_key or not tv_id:
            return None
        try:
            resp = requests.get(
                f"{self.BASE}/tv/{tv_id}",
                params={"api_key": self.api_key, "language": language},
                timeout=8,
            )
            resp.raise_for_status()
            d = resp.json()
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] détails série indisponibles : {err}")
            return None
        poster = d.get("poster_path")
        y = (d.get("first_air_date") or "")[:4]
        seasons = [
            {
                "seasonNumber": s.get("season_number"),
                "episodeCount": s.get("episode_count"),
                "name": s.get("name"),
            }
            for s in (d.get("seasons") or [])
        ]
        return {
            "tmdbId": d.get("id"),
            "title": d.get("name"),
            "originalTitle": d.get("original_name") or d.get("name"),
            "year": int(y) if y.isdigit() else None,
            "posterUrl": f"{self.IMG}/w500{poster}" if poster else None,
            "overview": d.get("overview"),
            "status": d.get("status"),
            "numberOfSeasons": d.get("number_of_seasons"),
            "seasons": seasons,
        }

    def tv_season(self, tv_id, season_number, language="fr-FR"):
        """
        Épisodes d'une saison : liste {ep, title, overview, still}. None si échec.
        """
        if not self.api_key or not tv_id:
            return None
        try:
            resp = requests.get(
                f"{self.BASE}/tv/{tv_id}/season/{season_number}",
                params={"api_key": self.api_key, "language": language},
                timeout=8,
            )
            resp.raise_for_status()
            eps = resp.json().get("episodes", [])
        except (requests.RequestException, ValueError) as err:
            print(f"[TMDB] saison indisponible : {err}")
            return None
        return [
            {
                "ep": e.get("episode_number"),
                "title": e.get("name"),
                "overview": e.get("overview") or None,
                "still": f"{self.IMG}/w300{e['still_path']}" if e.get("still_path") else None,
            }
            for e in eps
        ]

    def download_poster(self, poster_url, dest_path):
        """Télécharge une affiche vers dest_path. Retourne True si OK."""
        if not poster_url:
            return False
        try:
            resp = requests.get(poster_url, timeout=15)
            resp.raise_for_status()
            with open(dest_path, "wb") as f:
                f.write(resp.content)
            return True
        except (requests.RequestException, OSError) as err:
            print(f"[TMDB] téléchargement affiche échoué : {err}")
            return False


# Balises courantes de nom de torrent, coupées lors du nettoyage du titre.
_TORRENT_TAGS = re.compile(
    r"\b(720p|1080p|2160p|480p|4k|x264|x265|h\.?264|h\.?265|hevc|xvid|divx|"
    r"blu-?ray|brrip|bdrip|web-?rip|web-?dl|hdtv|dvd-?rip|hd-?rip|remux|"
    r"aac|ac3|dts|dd5\.?1|opus|10bits?|hdr10?|dv|"
    r"yify|yts|rarbg|extended|remastered|proper|repack|unrated|directors?\.?cut|"
    r"multi|vff|vfq|vostfr|truefrench|french|ita|eng|dual|lat).*$",
    re.IGNORECASE,
)


# --- Séries : extraction saison/épisode d'un nom de release ou de fichier ---
# À appliquer AVANT clean_torrent_title (dont les balises greedy coupent le SxxExx).
_EP_PATTERNS = [
    re.compile(r"\bS(\d{1,2})[\s._-]*E(\d{1,3})", re.I),                 # S02E03 / S02.E03
    re.compile(r"\b(\d{1,2})x(\d{1,3})\b", re.I),                        # 2x03
    re.compile(r"\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})", re.I),
]
_SEASON_ONLY_PATTERNS = [
    re.compile(r"\bS(\d{1,2})\b(?![\s._-]*E\d)", re.I),                  # S02 (pas suivi de Exx)
    re.compile(r"\bSeason[\s._-]*(\d{1,2})\b", re.I),                    # Season 2
]


def parse_episode(raw):
    """
    Extrait {season:int, episode:int} d'un nom (release ou fichier). Si seule la
    saison est reconnue (pack de saison) → {season, episode:None}. None sinon.
    """
    if not raw:
        return None
    for pat in _EP_PATTERNS:
        m = pat.search(raw)
        if m:
            return {"season": int(m.group(1)), "episode": int(m.group(2))}
    for pat in _SEASON_ONLY_PATTERNS:
        m = pat.search(raw)
        if m:
            return {"season": int(m.group(1)), "episode": None}
    return None


def clean_torrent_title(raw):
    """
    Extrait un (titre, année) exploitables d'un nom de torrent bruité.
    Ex. 'Leon The Professional Extended (1994) [1080p]' -> ('Leon The Professional', 1994).
    """
    year_match = re.search(r"\b(19|20)\d{2}\b", raw or "")
    year = int(year_match.group(0)) if year_match else None

    title = re.split(r"[\(\[]", raw or "")[0]      # coupe à la 1re parenthèse/crochet
    title = re.sub(r"[._]+", " ", title)            # points/underscores -> espaces
    title = _TORRENT_TAGS.sub("", title)            # retire balises qualité/codec/édition
    title = re.sub(r"\b(19|20)\d{2}\b", "", title)  # retire l'année du titre
    title = re.sub(r"\s+", " ", title).strip(" -")
    return title, year


# ---------------------------------------------------------------------------
# Sous-titres externes (OpenSubtitles) — SRT converti en WebVTT via ffmpeg
# ---------------------------------------------------------------------------

def _venv_bin(name):
    """Chemin d'un exécutable du venv du projet, ou None s'il n'y est pas."""
    path = Path(__file__).resolve().parent / "venv" / "bin" / name
    return str(path) if os.access(path, os.X_OK) else None


class Subtitles:
    """
    Récupère les meilleurs sous-titres fr/en depuis OpenSubtitles (clé API +
    identifiants gratuits requis) et les convertit en WebVTT pour le <track>.
    """

    BASE = "https://api.opensubtitles.com/api/v1"
    LANGS = ("fr", "en")

    def __init__(self, api_key, username="", password="", ffmpeg="ffmpeg"):
        self.api_key = api_key or ""
        self.username = username or ""
        self.password = password or ""
        self.ffmpeg = ffmpeg
        # Resynchro auto (best-effort) : activée seulement si le binaire est là.
        # Il vit dans le venv du projet, alors que .xinitrc lance l'API avec le
        # python système : on le cherche donc aussi à côté des sources (son
        # shebang pointe le python du venv, il s'exécute donc de façon autonome).
        self.ffsubsync = shutil.which("ffsubsync") or _venv_bin("ffsubsync")
        self._token = None
        self._token_ts = 0

    def available(self):
        return bool(self.api_key and self.username and self.password)

    @staticmethod
    def moviehash(path):
        """
        Hash OpenSubtitles d'un fichier vidéo : somme 64 bits de la taille et des
        premiers/derniers 64 Kio. Permet de retrouver le sous-titre calé sur CE
        release précis (bien plus fiable que la recherche par titre/imdb).
        Retourne une chaîne hex de 16 caractères, ou None si le fichier est trop
        petit ou illisible.
        """
        try:
            chunk = 65536
            size = os.path.getsize(path)
            if size < chunk * 2:
                return None
            h = size
            with open(path, "rb") as f:
                for _ in range(chunk // 8):
                    (val,) = struct.unpack("<q", f.read(8))
                    h = (h + val) & 0xFFFFFFFFFFFFFFFF
                f.seek(size - chunk)
                for _ in range(chunk // 8):
                    (val,) = struct.unpack("<q", f.read(8))
                    h = (h + val) & 0xFFFFFFFFFFFFFFFF
            return f"{h:016x}"
        except (OSError, struct.error) as err:
            print(f"[OpenSubtitles] moviehash impossible : {err}")
            return None

    def resync(self, vtt_path, video_path):
        """
        Recale un .vtt sur la bande-son via ffsubsync (best-effort, en place).
        Sans le binaire, ne fait rien et retourne False. Ne lève jamais.
        """
        if not self.ffsubsync:
            return False
        tmp = f"{vtt_path}.synced.vtt"
        try:
            proc = subprocess.run(
                [self.ffsubsync, str(video_path), "-i", str(vtt_path), "-o", tmp],
                capture_output=True, timeout=600,
            )
            if proc.returncode == 0 and os.path.exists(tmp):
                os.replace(tmp, vtt_path)
                print(f"[OpenSubtitles] resynchro OK : {os.path.basename(vtt_path)}")
                return True
            print(f"[OpenSubtitles] resynchro échouée ({proc.returncode})")
        except (subprocess.SubprocessError, OSError) as err:
            print(f"[OpenSubtitles] resynchro impossible : {err}")
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return False

    def _headers(self, auth=False):
        h = {
            "Api-Key": self.api_key,
            "User-Agent": "tv-app v1.0",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if auth and self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def _login(self):
        """Ouvre une session (token valable ~24h, mis en cache)."""
        if self._token and (time.time() - self._token_ts) < 20 * 3600:
            return self._token
        resp = requests.post(
            f"{self.BASE}/login",
            json={"username": self.username, "password": self.password},
            headers=self._headers(), timeout=10,
        )
        resp.raise_for_status()
        self._token = resp.json().get("token")
        self._token_ts = time.time()
        return self._token

    def fetch(self, imdb_id=None, tmdb_id=None, title=None, year=None,
              out_dir=".", base_name="movie", video_path=None, want_langs=None,
              season=None, episode=None):
        """
        Cherche, télécharge et convertit les sous-titres en WebVTT.

        Si `video_path` est fourni, on calcule son moviehash pour retrouver le
        sous-titre calé sur CE release (bien plus fiable), puis on tente une
        resynchro auto sur la bande-son (best-effort). `want_langs` restreint aux
        langues manquantes (les embarqués sont récupérés avant, en amont).
        Retourne {lang: filename.vtt}. Ne lève pas si une langue manque.
        """
        if not self.available():
            return {}
        self._login()

        langs = want_langs or self.LANGS
        movie_hash = self.moviehash(video_path) if video_path else None

        out = {}
        for lang in langs:
            try:
                file_id = self._best_file_id(lang, imdb_id, tmdb_id, title, year,
                                             movie_hash, season, episode)
                if not file_id:
                    continue
                srt_text = self._download_srt(file_id)
                if not srt_text:
                    continue
                vtt_name = self._srt_to_vtt(srt_text, out_dir, base_name, lang)
                if not vtt_name:
                    continue
                # Filet de sécurité contre la dérive : recale sur l'audio.
                if video_path:
                    self.resync(Path(out_dir) / vtt_name, video_path)
                out[lang] = vtt_name
            except requests.RequestException as err:
                print(f"[OpenSubtitles] {lang} échoué : {err}")
        return out

    def _best_file_id(self, lang, imdb_id, tmdb_id, title=None, year=None,
                      movie_hash=None, season=None, episode=None):
        params = {"languages": lang, "order_by": "download_count"}
        # Le moviehash cible le release exact : on le passe EN PLUS des autres
        # critères, puis on privilégie les résultats qui matchent le hash.
        if movie_hash:
            params["moviehash"] = movie_hash
        # Série : restreint à l'épisode voulu (OpenSubtitles gère season/episode).
        if season is not None:
            params["season_number"] = season
        if episode is not None:
            params["episode_number"] = episode
        if imdb_id:
            params["imdb_id"] = str(imdb_id).lstrip("t")  # 'tt123' -> '123'
        elif tmdb_id:
            params["tmdb_id"] = tmdb_id
        elif title:
            params["query"] = title           # repli : recherche par titre...
            if year:
                params["year"] = year          # ...affinée par l'année si connue
        elif not movie_hash:
            return None
        resp = requests.get(f"{self.BASE}/subtitles", params=params,
                            headers=self._headers(), timeout=10)
        resp.raise_for_status()
        data = resp.json().get("data", [])
        # Les correspondances par moviehash d'abord (sous-titre du bon release).
        data.sort(key=lambda it: not it.get("attributes", {}).get("moviehash_match"))
        for item in data:
            files = item.get("attributes", {}).get("files", [])
            if files:
                return files[0].get("file_id")
        return None

    def _download_srt(self, file_id):
        resp = requests.post(f"{self.BASE}/download", json={"file_id": file_id},
                             headers=self._headers(auth=True), timeout=10)
        resp.raise_for_status()
        link = resp.json().get("link")
        if not link:
            return None
        srt = requests.get(link, timeout=20)
        srt.raise_for_status()
        return srt.content  # bytes (encodage variable, ffmpeg gère)

    def _srt_to_vtt(self, srt_bytes, out_dir, base_name, lang):
        """Convertit un SRT en WebVTT via ffmpeg (pipe stdin -> fichier)."""
        import subprocess
        out_name = f"{base_name}.{lang}.vtt"
        out_path = Path(out_dir) / out_name
        proc = subprocess.run(
            [self.ffmpeg, "-y", "-f", "srt", "-i", "pipe:0", str(out_path)],
            input=srt_bytes, capture_output=True, timeout=60,
        )
        if proc.returncode == 0 and out_path.exists():
            return out_name
        out_path.unlink(missing_ok=True)
        return None
