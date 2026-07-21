"""
Orchestrateur des séries : relie TMDB (structure saisons/épisodes), l'indexeur
Jackett (recherche torrent, catégories TV) et le JobWorker (téléchargement +
mapping des fichiers → épisodes).

Stratégie d'acquisition **hybride** :
  - « épisode » : cherche un torrent `Show SxxExx` → job pack à 1 cible.
  - « saison »  : cherche un pack `Show Sxx` → job pack ciblant tous les épisodes
                  de la saison ; les épisodes non trouvés dans le pack partent en
                  repli épisode-unique (on_pack_done).
  - « série »   : enchaîne le flux « saison » sur chaque saison.

Toute acquisition passe par un **job `pack`** (voir JobWorker._process_pack) —
un épisode unique = un pack à une seule cible. Le worker n'a donc qu'un chemin
série, et les entrées `episode` sont toujours créées par lui.
"""

import time

# Catégories Torznab TV (5000 = TV et ses sous-catégories).
CAT_TV = "5000,5010,5020,5030,5040,5045,5050,5060,5070,5080"

# Au-delà de cette fraction lue, un épisode est considéré « vu ».
# Même seuil que MovieLibrary.WATCHED_THRESHOLD côté front.
WATCHED_THRESHOLD = 0.92


class SeriesManager:
    def __init__(self, library, tmdb, indexer, worker, slugify, posters_dir):
        self.library = library
        self.tmdb = tmdb
        self.indexer = indexer
        self.worker = worker
        self.slugify = slugify
        self.posters_dir = posters_dir
        # Dernière issue de recherche PAR SÉRIE, remontée à la popup : sans ça,
        # un indexeur muet (ou éteint) se traduisait par « rien ne se passe ».
        self.notices = {}
        # Repli épisode-unique en fin de pack saison/série.
        worker.on_pack_done = self._on_pack_done

    # ---------------------------------------------------------------- helpers

    def _episode_id(self, show_id, season, episode):
        return f"{show_id}-s{int(season):02d}e{int(episode):02d}"

    def _eng_title(self, show):
        """Titre pour la recherche torrent (anglais de préférence)."""
        return (self.tmdb.english_tv_title(show.get('tmdbId'))
                or show.get('originalTitle') or show.get('title') or '')

    def _search_candidates(self, query, limit=25, top=6):
        """
        Magnets candidats (triés par seeders) pour `query` en catégorie TV. On en
        renvoie plusieurs : beaucoup viennent de trackers privés (injoignables sans
        passkey) → le worker essaie les suivants si le premier échoue.
        """
        if not self.indexer.available():
            return []
        results = self.indexer.search(query, limit=limit, cat=CAT_TV)
        magnets = []
        for movie in results:  # déjà triés par seeders décroissant
            for t in (movie.get('torrents') or []):
                if t.get('magnet'):
                    magnets.append(t['magnet'])
        return magnets[:top]

    def _season_targets(self, show, season):
        """Liste des cibles {season, episode, episodeId, title} d'une saison."""
        eps = self.tmdb.tv_season(show.get('tmdbId'), season) or []
        if not eps:
            # Repli : nombre d'épisodes depuis le résumé des saisons.
            count = next((s.get('episodeCount') for s in show.get('seasons', [])
                          if s.get('seasonNumber') == season), 0) or 0
            eps = [{"ep": i, "title": None} for i in range(1, count + 1)]
        return [{
            "season": season, "episode": e['ep'],
            "episodeId": self._episode_id(show['id'], season, e['ep']),
            "title": e.get('title'),
        } for e in eps if e.get('ep')]

    def _start_pack(self, show, candidates, targets, scope, season, fallback):
        """Crée et enfile un job pack ciblant `targets` (essaie chaque candidat)."""
        if not targets or not candidates:
            return None
        label = ("Série complète" if scope == 'series'
                 else f"Saison {season}" if scope == 'season'
                 else f"S{int(season):02d}E{int(targets[0]['episode']):02d}")
        pack_id = (f"{show['id']}-pack-s{int(season):02d}" if scope in ('season', 'series')
                   else f"{show['id']}-pack-{targets[0]['episodeId']}")
        pack = {
            "id": pack_id, "type": "pack",
            "showId": show['id'], "showTitle": show.get('title'),
            "tmdbId": show.get('tmdbId'), "year": show.get('year'),
            "title": f"{show.get('title')} — {label}",
            "scope": scope, "season": season, "fallback": bool(fallback),
            "candidates": candidates, "magnet": candidates[0], "targets": targets,
            "status": "queued", "progress": {}, "error": None,
            "addedAt": int(time.time()),
        }
        self.library.upsert(pack)
        self.worker.enqueue(pack_id)
        return pack_id

    # ---------------------------------------------------------------- API

    def add_show(self, tmdb_id):
        """Enregistre une série (structure TMDB + affiche locale). Retourne l'entrée."""
        det = self.tmdb.tv_details(tmdb_id)
        if not det:
            return None
        show_id = self.slugify(det['title'], det.get('year'))
        existing = self.library.get(show_id)
        poster = existing.get('poster') if existing else None
        if not poster and det.get('posterUrl'):
            if self.tmdb.download_poster(det['posterUrl'], self.posters_dir / f"{show_id}.jpg"):
                poster = f"{show_id}.jpg"
        show = {
            "id": show_id, "type": "series",
            "tmdbId": det['tmdbId'], "title": det['title'],
            "originalTitle": det.get('originalTitle'), "year": det.get('year'),
            "overview": det.get('overview'), "poster": poster,
            "tmdbStatus": det.get('status'),
            "numberOfSeasons": det.get('numberOfSeasons'),
            # Saisons réelles (hors specials saison 0).
            "seasons": [s for s in det.get('seasons', []) if s.get('seasonNumber')],
            # 'ready' : entrée catalogue (pas un job) → exclue de active_jobs et de
            # resume_pending ; le front l'affiche via son type 'series'.
            "status": "ready",
            "addedAt": (existing.get('addedAt') if existing else int(time.time())),
            "lastCheckedAt": int(time.time()),
        }
        self.library.upsert(show)
        return show

    def download(self, show_id, scope, season=None, episode=None):
        """
        Lance le téléchargement selon le scope. Retourne un résumé
        {queued:[pack_ids], errors:[messages]}.
        """
        show = self.library.get(show_id)
        if not show or show.get('type') != 'series':
            return {"error": "Série inconnue"}
        eng = self._eng_title(show)
        queued, errors = [], []

        if scope == 'episode':
            s, e = int(season), int(episode)
            cands = self._search_candidates(f"{eng} S{s:02d}E{e:02d}")
            if not cands:
                errors.append(f"Aucune source pour S{s:02d}E{e:02d}")
            else:
                t = {"season": s, "episode": e,
                     "episodeId": self._episode_id(show_id, s, e), "title": None}
                pid = self._start_pack(show, cands, [t], 'episode', s, fallback=False)
                if pid:
                    queued.append(pid)

        elif scope == 'season':
            s = int(season)
            targets = self._season_targets(show, s)
            cands = self._search_candidates(f"{eng} S{s:02d}")
            if cands:
                pid = self._start_pack(show, cands, targets, 'season', s, fallback=True)
                if pid:
                    queued.append(pid)
            else:
                # Pas de pack : repli direct épisode par épisode.
                for t in targets:
                    r = self.download(show_id, 'episode', s, t['episode'])
                    queued.extend(r.get('queued', []))
                    errors.extend(r.get('errors', []))

        elif scope == 'series':
            for meta in show.get('seasons', []):
                n = meta.get('seasonNumber')
                if not n:
                    continue
                r = self.download(show_id, 'season', n)
                queued.extend(r.get('queued', []))
                errors.extend(r.get('errors', []))
        else:
            return {"error": f"scope inconnu : {scope}"}

        return {"queued": queued, "errors": errors}

    def download_async(self, show_id, scope, season=None, episode=None):
        """
        `download` exécuté en thread (les recherches d'indexeur sont longues),
        en mémorisant l'issue dans `notices` pour que la popup l'affiche.
        """
        self._notice(show_id, "Searching sources…")
        try:
            res = self.download(show_id, scope, season, episode)
        except Exception as err:                       # jamais silencieux
            print(f"[Series] Téléchargement {show_id} en échec : {err}")
            self._notice(show_id, f"Search failed: {err}")
            return
        if res.get('error'):
            self._notice(show_id, res['error'])
        elif res.get('queued'):
            self._notice(show_id, None)                # la progression parle d'elle-même
        else:
            errors = res.get('errors') or []
            self._notice(show_id, errors[0] if errors else 'No source found')

    def _notice(self, show_id, text):
        self.notices[show_id] = {"at": time.time(), "text": text}

    def notice(self, show_id):
        """Message courant d'une série (périmé au bout d'une minute)."""
        n = self.notices.get(show_id)
        if not n or time.time() - n['at'] > 60:
            return None
        return n['text']

    def _on_pack_done(self, pack, fulfilled, missing):
        """Fin d'un pack saison/série : repli épisode-unique sur les manquants."""
        if not pack.get('fallback') or not missing:
            return
        show_id = pack.get('showId')
        for t in missing:
            print(f"[Series] Repli épisode-unique : {t['episodeId']}")
            self.download(show_id, 'episode', t['season'], t['episode'])

    # ---------------------------------------------------------------- lecture / état

    def season_view(self, show_id, season):
        """
        Épisodes d'une saison enrichis de leur état local
        (missing | downloading | ready | error) pour la popup.
        """
        show = self.library.get(show_id)
        if not show:
            return None
        eps = self.tmdb.tv_season(show.get('tmdbId'), season) or []
        lib = self.library.all()
        # Épisodes réellement CIBLÉS par un pack actif → (season, episode) : progrès
        # DL du pack. Un pack « épisode » ne couvre qu'une cible ; un pack saison/
        # série couvre chacune de ses cibles. Évite d'afficher toute la saison « en
        # cours » quand un seul épisode se télécharge.
        covered = {}
        for e in lib.values():
            if (e.get('type') == 'pack' and e.get('showId') == show_id
                    and e.get('status') in ('queued', 'downloading', 'transcoding')):
                dl = (e.get('progress', {}) or {}).get('download', 0)
                for t in e.get('targets', []):
                    covered[(t['season'], t['episode'])] = dl
        out = []
        for e in eps:
            ep = e.get('ep')
            if not ep:
                continue
            entry = lib.get(self._episode_id(show_id, season, ep))
            state, progress, phase = 'missing', 0.0, None
            current, duration, watched = 0.0, 0.0, False
            if entry:
                # Avancement de LECTURE (distinct de `progress`, qui suit
                # l'acquisition) : alimente la pastille « vu » et la barre de
                # visionnage du volet d'info.
                current = entry.get('currentTime') or 0
                duration = entry.get('duration') or 0
                watched = bool(entry.get('watched')) or (
                    duration > 0 and current >= WATCHED_THRESHOLD * duration)
                st = entry.get('status')
                p = entry.get('progress', {}) or {}
                if st == 'ready':
                    state, progress = 'ready', 1.0
                elif st == 'error':
                    state = 'error'
                elif st == 'transcoding':
                    state, phase, progress = 'downloading', 'transcoding', p.get('transcode', 0)
                elif st == 'downloading':
                    state, phase, progress = 'downloading', 'downloading', p.get('download', 0)
                else:  # queued / fetching-subs
                    state, phase = 'downloading', st
            elif (season, ep) in covered:
                state, phase, progress = 'downloading', 'downloading', covered[(season, ep)]
            out.append({
                "ep": ep, "title": e.get('title'), "overview": e.get('overview'),
                "still": e.get('still'), "state": state,
                "progress": round(progress, 3), "phase": phase,
                "currentTime": round(current, 1), "duration": round(duration, 1),
                "watched": watched,
            })
        return {"season": season, "episodes": out, "notice": self.notice(show_id)}

    def recheck_airing(self):
        """Re-fetch TMDB pour les séries en cours de diffusion (nouveaux épisodes)."""
        for show_id, show in list(self.library.all().items()):
            if show.get('type') != 'series':
                continue
            if show.get('tmdbStatus') not in ('Returning Series', 'In Production'):
                continue
            det = self.tmdb.tv_details(show.get('tmdbId'))
            if not det:
                continue
            self.library.patch(show_id, {
                "tmdbStatus": det.get('status'),
                "numberOfSeasons": det.get('numberOfSeasons'),
                "seasons": [s for s in det.get('seasons', []) if s.get('seasonNumber')],
                "lastCheckedAt": int(time.time()),
            })
            print(f"[Series] Re-check {show_id} : {det.get('status')}, "
                  f"{det.get('numberOfSeasons')} saisons")
