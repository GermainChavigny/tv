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


class SeriesManager:
    def __init__(self, library, tmdb, indexer, worker, slugify, posters_dir):
        self.library = library
        self.tmdb = tmdb
        self.indexer = indexer
        self.worker = worker
        self.slugify = slugify
        self.posters_dir = posters_dir
        # Repli épisode-unique en fin de pack saison/série.
        worker.on_pack_done = self._on_pack_done

    # ---------------------------------------------------------------- helpers

    def _episode_id(self, show_id, season, episode):
        return f"{show_id}-s{int(season):02d}e{int(episode):02d}"

    def _eng_title(self, show):
        """Titre pour la recherche torrent (anglais de préférence)."""
        return (self.tmdb.english_tv_title(show.get('tmdbId'))
                or show.get('originalTitle') or show.get('title') or '')

    def _search_best(self, query, limit=20):
        """Meilleur torrent (plus de seeders) pour `query` en catégorie TV, ou None."""
        if not self.indexer.available():
            return None
        results = self.indexer.search(query, limit=limit, cat=CAT_TV)
        for movie in results:  # déjà triés par seeders décroissant
            tors = movie.get('torrents') or []
            if tors and tors[0].get('magnet'):
                return {"magnet": tors[0]['magnet'], "title": movie.get('title'),
                        "seeders": tors[0].get('seeders')}
        return None

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

    def _start_pack(self, show, magnet, targets, scope, season, fallback):
        """Crée et enfile un job pack ciblant `targets`."""
        if not targets:
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
            "magnet": magnet, "targets": targets,
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
            best = self._search_best(f"{eng} S{s:02d}E{e:02d}")
            if not best:
                errors.append(f"Aucune source pour S{s:02d}E{e:02d}")
            else:
                t = {"season": s, "episode": e,
                     "episodeId": self._episode_id(show_id, s, e), "title": None}
                pid = self._start_pack(show, best['magnet'], [t], 'episode', s, fallback=False)
                if pid:
                    queued.append(pid)

        elif scope == 'season':
            s = int(season)
            targets = self._season_targets(show, s)
            best = self._search_best(f"{eng} S{s:02d}")
            if best:
                pid = self._start_pack(show, best['magnet'], targets, 'season', s, fallback=True)
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
        # Pack actif couvrant cette saison (donne la progression de téléchargement
        # des épisodes pas encore extraits en entrée propre).
        pack = next((e for e in lib.values()
                     if e.get('type') == 'pack' and e.get('showId') == show_id
                     and (e.get('scope') == 'series' or e.get('season') == season)), None)
        pack_dl = (pack.get('progress', {}) or {}).get('download', 0) if pack else 0
        out = []
        for e in eps:
            ep = e.get('ep')
            if not ep:
                continue
            entry = lib.get(self._episode_id(show_id, season, ep))
            state, progress, phase = 'missing', 0.0, None
            if entry:
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
            elif pack:
                state, phase, progress = 'downloading', 'downloading', pack_dl
            out.append({
                "ep": ep, "title": e.get('title'), "overview": e.get('overview'),
                "still": e.get('still'), "state": state,
                "progress": round(progress, 3), "phase": phase,
            })
        return {"season": season, "episodes": out}

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
