"""
Sources externes du volet films : secrets, indexeur de torrents (avec repli
sur IP directe si le domaine tombe) et métadonnées TMDB.

Tout ce qui est spécifique à un fournisseur (domaines, IP de secours, clés API)
vit dans tv_data/secrets.json — JAMAIS dans le dépôt git. Le code ne contient
que la *forme* des échanges, à la manière de Jackett/Radarr. L'usage licite du
contenu relève de l'utilisateur.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter


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
        # Deux types disponibles (à compléter par l'utilisateur) :
        #
        # 1) type "yts" — API au format YTS (/api/v2/list_movies.json) :
        # {
        #   "name": "mon-indexeur", "type": "yts",
        #   "bases": [                       # essayés dans l'ordre, + repli DoH auto
        #     {"host": "exemple.tld", "ip": null, "scheme": "https"},
        #     {"host": "exemple.tld", "ip": "1.2.3.4", "scheme": "https"}
        #   ]
        # }
        #
        # 2) type "generic" — N'IMPORTE quelle API JSON, tu décris le mapping :
        # {
        #   "name": "mon-api", "type": "generic",
        #   "bases": [{"host": "exemple.tld", "ip": null, "scheme": "https"}],
        #   "path": "/api/search",           # endpoint de recherche
        #   "queryParam": "q",               # nom du paramètre de requête
        #   "extraParams": {"limit": 30},    # paramètres fixes éventuels
        #   "map": {                         # chemins pointés dans la réponse JSON
        #     "results": "data.items",       #   tableau des résultats ("" = racine)
        #     "title":   "name",
        #     "year":    "year",
        #     "magnet":  "magnet",           #   lien magnet complet...
        #     "hash":    "info_hash",        #   ...OU info-hash (magnet reconstruit)
        #     "name":    "name",             #   nom pour le magnet reconstruit
        #     "seeders": "seeders",
        #     "size":    "size",
        #     "quality": "quality",
        #     "poster":  "poster",
        #     "imdb":    "imdb_id"
        #   }
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
# Requêtes résilientes : domaine puis repli IP directe (Host + SNI conservés)
# ---------------------------------------------------------------------------

class _SNIAdapter(HTTPAdapter):
    """
    Adapte TLS pour présenter le bon nom de domaine (SNI) alors qu'on se
    connecte à une IP directe. Sans ça, un CDN rejette la poignée de main.
    """

    def __init__(self, server_hostname, **kwargs):
        self._server_hostname = server_hostname
        super().__init__(**kwargs)

    def init_poolmanager(self, *args, **kwargs):
        kwargs["server_hostname"] = self._server_hostname
        kwargs["assert_hostname"] = False
        super().init_poolmanager(*args, **kwargs)


def resolve_via_doh(host):
    """
    Résout `host` en IPv4 via DNS-over-HTTPS (Cloudflare puis Google), en
    contournant un résolveur système empoisonné. Retourne une IP publique
    exploitable ou None (NXDOMAIN, ou seulement des IP locales = sinkhole).
    """
    providers = [
        "https://1.1.1.1/dns-query",
        "https://dns.google/resolve",
    ]
    for provider in providers:
        try:
            r = requests.get(provider, params={"name": host, "type": "A"},
                             headers={"accept": "application/dns-json"}, timeout=6)
            answers = r.json().get("Answer", [])
            for a in answers:
                ip = a.get("data", "")
                # type 1 = A ; on écarte localhost / IP privées (sinkhole)
                if a.get("type") == 1 and not ip.startswith(("127.", "10.", "0.")):
                    return ip
        except (requests.RequestException, ValueError):
            continue
    return None


def request_with_fallback(bases, path, params=None, timeout=8):
    """
    Tente une requête GET JSON sur chaque base jusqu'à succès, dans l'ordre :
      1) le domaine (résolveur système) ;
      2) l'IP de secours fournie dans la config, si présente ;
      3) l'IP réelle résolue via DoH (auto-contournement d'un DNS empoisonné).
    Les tentatives par IP conservent l'en-tête Host et le SNI = domaine.

    Retourne (json, base_utilisée) ou lève la dernière exception.
    """
    last_err = None
    for base in bases:
        host = base["host"]
        scheme = base.get("scheme", "https")

        # (url, sni_host, verify) — sni_host non nul ⇒ connexion par IP
        attempts = [(f"{scheme}://{host}{path}", None, True)]
        if base.get("ip"):
            attempts.append((f"{scheme}://{base['ip']}{path}", host, False))

        for url, sni_host, verify in attempts:
            try:
                return _do_get(url, sni_host, verify, scheme, params, timeout), base
            except (requests.RequestException, ValueError) as err:
                last_err = err
                continue

        # Dernier recours : IP réelle via DoH (si pas déjà fournie)
        if not base.get("ip"):
            doh_ip = resolve_via_doh(host)
            if doh_ip:
                try:
                    url = f"{scheme}://{doh_ip}{path}"
                    return _do_get(url, host, False, scheme, params, timeout), base
                except (requests.RequestException, ValueError) as err:
                    last_err = err

    if last_err:
        raise last_err
    raise RuntimeError("Aucun indexeur configuré")


def _do_get(url, sni_host, verify, scheme, params, timeout):
    """Effectue le GET JSON, en réglant Host + SNI si on tape une IP directe."""
    session = requests.Session()
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if sni_host:
        headers["Host"] = sni_host
        session.mount(f"{scheme}://", _SNIAdapter(sni_host))
        verify = False
    resp = session.get(url, params=params, headers=headers, timeout=timeout, verify=verify)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Indexeur de torrents (forme de réponse « yts » = shape JSON courante)
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


# Extensions vidéo acceptées (filtre videoOnly). Aligné sur movie_pipeline.
VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.ts', '.wmv', '.flv', '.mpg', '.mpeg'}


def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _to_num(v, default=0.0):
    try:
        return float(v)
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


def _dig(obj, path):
    """
    Navigue un objet JSON via un chemin pointé ('a.b.c').
    path='' -> l'objet lui-même (cas d'un tableau à la racine) ; path=None -> None.
    Retourne None si le chemin n'existe pas.
    """
    if path is None:
        return None
    if path == "":
        return obj
    cur = obj
    for key in path.split("."):
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return None
    return cur


class Indexer:
    """
    Recherche de torrents de films sur un ou plusieurs indexeurs configurés,
    avec repli sur IP directe. Résultats normalisés et agrégés par film.
    """

    def __init__(self, indexers):
        self.indexers = indexers or []

    def available(self):
        return bool(self.indexers)

    def search(self, query, limit=20):
        """
        Retourne une liste de films normalisés :
        [{title, year, imdbId, cover, torrents: [{quality, seeders, size, magnet}]}]
        """
        results = []
        for cfg in self.indexers:
            try:
                kind = cfg.get("type")
                if kind == "yts":
                    results.extend(self._search_yts(cfg, query, limit))
                elif kind == "generic":
                    results.extend(self._search_generic(cfg, query, limit))
                else:
                    print(f"[Indexer] type inconnu : {kind}")
            except Exception as err:  # un indexeur HS ne casse pas la recherche
                print(f"[Indexer] {cfg.get('name')} en échec : {err}")
        return results

    def _search_generic(self, cfg, query, limit):
        """
        Indexeur configurable : le mapping des champs de la réponse JSON est
        entièrement décrit dans la config (secrets.json), donc aucune forme
        d'API n'est codée en dur. Voir SECRETS_TEMPLATE pour les clés attendues.

        Filtrage/tri optionnels via cfg['filter'] et cfg['sort'] :
          filter.minSeeders (défaut 1), filter.maxSizeGb (défaut aucun),
          filter.videoOnly (défaut True, exige une extension vidéo),
          sort = 'seeders' (défaut) | 'score' | 'health'.

        Pagination optionnelle : cfg['pages'] (nombre de pages à agréger, défaut 1)
        et cfg['pageParam'] (nom du paramètre de page, défaut 'page'). On s'arrête
        tôt dès qu'une page revient vide.
        """
        m = cfg.get("map", {})
        flt = cfg.get("filter", {})
        min_seeders = flt.get("minSeeders", 1)
        max_bytes = flt.get("maxSizeGb", 0) * (1024 ** 3) if flt.get("maxSizeGb") else None
        video_only = flt.get("videoOnly", True)
        sort_key = cfg.get("sort", "seeders")

        base_params = dict(cfg.get("extraParams", {}))
        base_params[cfg.get("queryParam", "q")] = query
        page_param = cfg.get("pageParam", "page")
        pages = max(1, int(cfg.get("pages", 1)))

        items = []
        for page in range(1, pages + 1):
            params = dict(base_params)
            if pages > 1 or page_param in base_params:
                params[page_param] = page
            data, _ = request_with_fallback(cfg["bases"], cfg.get("path", "/"), params=params)
            page_items = _dig(data, m.get("results", ""))
            if isinstance(page_items, dict):     # réponse "objet" -> valeurs
                page_items = list(page_items.values())
            if not isinstance(page_items, list) or not page_items:
                break  # plus de résultats : inutile de demander les pages suivantes
            items.extend(page_items)
            if len(page_items) < 2:
                break  # page manifestement incomplète : on arrête

        # Filtres DURS (source injouable/inatteignable) vs. SOUPLE (taille).
        # Le cap de taille est une préférence : s'il ne reste plus rien après
        # l'avoir appliqué, on garde quand même les sources trop grosses (le
        # transcodage les ramène en 720p). Évite les « aucun résultat » alors que
        # des torrents valides existent — typique des vieux films dont les seules
        # sources partagées sont de gros remux.
        strict, oversized = [], []
        seen = set()
        for it in items:
            magnet = _dig(it, m.get("magnet"))
            if not magnet:
                h = _dig(it, m.get("hash"))
                if h:
                    magnet = build_magnet(h, _dig(it, m.get("name")))
            if not magnet:
                continue  # rien de téléchargeable

            # Dédoublonnage inter-pages : une même source peut réapparaître.
            key = _magnet_hash(magnet) or magnet
            if key in seen:
                continue
            seen.add(key)

            seeders = _to_int(_dig(it, m.get("seeders")))
            if seeders < min_seeders:
                continue  # source sans partageur = téléchargement voué à l'échec

            if video_only:
                fname = _dig(it, m.get("file")) or ""
                if fname and Path(fname).suffix.lower() not in VIDEO_EXTS:
                    continue  # .iso, .flac, .mp3… : pas un film jouable

            size_bytes = _to_int(_dig(it, m.get("sizeBytes")))
            too_big = bool(max_bytes and size_bytes and size_bytes > max_bytes)

            score = _to_num(_dig(it, m.get("score")))
            health = _to_num(_dig(it, m.get("health")))
            sort_val = {"seeders": seeders, "score": score, "health": health}.get(sort_key, seeders)

            movie = {
                "title": _dig(it, m.get("title")) or "?",
                "year": _dig(it, m.get("year")),
                "imdbId": _dig(it, m.get("imdb")),
                "cover": _dig(it, m.get("poster")),
                "torrents": [{
                    "quality": _dig(it, m.get("quality")),
                    "seeders": seeders,
                    "size": _dig(it, m.get("size")) or _human_size(size_bytes),
                    "magnet": magnet,
                }],
            }
            (oversized if too_big else strict).append((sort_val, movie))

        # On privilégie les sources sous le cap ; sinon on se rabat sur les grosses.
        scored = strict or oversized
        scored.sort(key=lambda x: x[0], reverse=True)
        return [mv for _, mv in scored[:limit]]

    def _search_yts(self, cfg, query, limit):
        data, _ = request_with_fallback(
            cfg["bases"], "/api/v2/list_movies.json",
            params={"query_term": query, "limit": limit},
        )
        movies = (data.get("data") or {}).get("movies") or []
        out = []
        for m in movies:
            torrents = []
            for t in m.get("torrents", []):
                torrents.append({
                    "quality": t.get("quality"),
                    "seeders": t.get("seeds", 0),
                    "size": t.get("size"),
                    "magnet": build_magnet(t["hash"], m.get("title_long")),
                })
            # meilleures sources en premier (plus de seeders)
            torrents.sort(key=lambda x: x.get("seeders", 0), reverse=True)
            out.append({
                "title": m.get("title"),
                "year": m.get("year"),
                "imdbId": m.get("imdb_code"),
                "cover": m.get("medium_cover_image") or m.get("large_cover_image"),
                "torrents": torrents,
            })
        return out


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


def normalize_title(title):
    """Nettoie un titre pour comparaison/recherche."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", title or "")).strip().lower()


# Balises courantes de nom de torrent, coupées lors du nettoyage du titre.
_TORRENT_TAGS = re.compile(
    r"\b(720p|1080p|2160p|480p|4k|x264|x265|h\.?264|h\.?265|hevc|xvid|divx|"
    r"blu-?ray|brrip|bdrip|web-?rip|web-?dl|hdtv|dvd-?rip|hd-?rip|remux|"
    r"aac|ac3|dts|dd5\.?1|opus|10bits?|hdr10?|dv|"
    r"yify|yts|rarbg|extended|remastered|proper|repack|unrated|directors?\.?cut|"
    r"multi|vff|vfq|vostfr|truefrench|french|ita|eng|dual|lat).*$",
    re.IGNORECASE,
)


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
        # Non installé par défaut (ffsubsync tire numpy/scipy) ; voir README.
        self.ffsubsync = shutil.which("ffsubsync")
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
              out_dir=".", base_name="movie", video_path=None, want_langs=None):
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
                file_id = self._best_file_id(lang, imdb_id, tmdb_id, title, year, movie_hash)
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

    def _best_file_id(self, lang, imdb_id, tmdb_id, title=None, year=None, movie_hash=None):
        params = {"languages": lang, "order_by": "download_count"}
        # Le moviehash cible le release exact : on le passe EN PLUS des autres
        # critères, puis on privilégie les résultats qui matchent le hash.
        if movie_hash:
            params["moviehash"] = movie_hash
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
