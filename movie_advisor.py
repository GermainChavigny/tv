"""
Movie Advisor : moteur de recommandation (Gemini) + blacklist persistante.

Le moteur reçoit des critères (humeur, époque, thème…) et rend exactement 3
films, avec un résumé court en français. La liste d'exclusion est montée par
l'appelant (api.py) : films écartés via « Forget » + films déjà possédés.

La clé API vit dans tv_data/secrets.json — JAMAIS dans le dépôt git. Comme le
reste du volet films, tout échoue en douceur : une panne réseau ou une clé
absente renvoie None et n'a jamais le droit de propager une 500.
"""

import json
import re
import threading
import time
from pathlib import Path

import requests

from movie_pipeline import atomic_write_json


# ---------------------------------------------------------------------------
# Blacklist « Forget », persistée dans tv_data/advisor_blacklist.json
# ---------------------------------------------------------------------------


class Blacklist:
    """
    Films que l'advisor ne doit plus jamais proposer.

    Même contrat que Library : lecture à la demande (pas de cache mémoire, le
    fichier est minuscule), un seul writer à la fois, écriture atomique, et un
    fichier illisible repart d'une liste vide plutôt que de tout casser.
    """

    def __init__(self, data_dir):
        self.path = Path(data_dir) / "advisor_blacklist.json"
        self._lock = threading.Lock()

    def _read(self):
        if not self.path.exists():
            return {}
        try:
            with open(self.path, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as err:
            print(f"[Advisor] Blacklist illisible ({err}), repart d'une liste vide")
            return {}

    def all(self):
        """Retourne le dict complet {id: entry}."""
        return self._read()

    def titles(self):
        """Les titres seuls, pour la section « exclusions » du prompt."""
        return [e.get("title") for e in self._read().values() if e.get("title")]

    def add(self, entry):
        """Insère (ou remplace) une entrée {id, title, year}."""
        with self._lock:
            data = self._read()
            data[entry["id"]] = entry
            atomic_write_json(self.path, data)
        return entry


# ---------------------------------------------------------------------------
# Moteur de recommandation : Google Gemini (offre gratuite)
# ---------------------------------------------------------------------------

PROMPT = """You are Movie Advisor.
Your role is to recommend exactly 3 movies.
The user owns a personal movie library and wants recommendations according to the selected criteria.
Do not recommend movies that appear in the excluded list.
Recommendations should be diverse.
Avoid suggesting three movies that are too similar.
For each recommendation, do a short film synopsis, with no spoiler (maximum 120 characters) in french.

--------------------------------------------------

Selected criteria

{criteria}
{extra}
--------------------------------------------------

Movies that must NEVER be recommended

{excluded}

--------------------------------------------------

Return ONLY valid JSON.

Schema:

{{
  "recommendations": [
    {{
      "title": "Movie title",
      "year": 1999,
      "description": "Short film synopsis, no spoiler (max 120 characters, french)"
    }}
  ]
}}


Rules:

- Return exactly 3 recommendations.
- No markdown.
- No explanations outside the JSON.
- No comments.
- The JSON must be valid.
- Do not recommend excluded movies.
- Prefer critically acclaimed films.
- The three movies should not all come from the same franchise.
- Do not invent movie titles."""

# Libellés envoyés au modèle (les clés viennent du front, cf. CRITERIA).
CRITERIA_LABELS = {
    "mood": "Mood",
    "pace": "Pace",
    "era": "Era",
    "scale": "Scale",
    "rating": "Rating",
    "length": "Length",
    "theme1": "Theme 1",
    "theme2": "Theme 2",
}


class AdvisorError(Exception):
    """Échec côté moteur, avec un message montrable à l'utilisateur."""


class _Transient(Exception):
    """Erreur passagère (surcharge/réseau) : on retente puis on passe au suivant."""


# Codes HTTP considérés comme passagers (surcharge / indispo momentanée).
_TRANSIENT_CODES = {429, 500, 502, 503, 504}


class Provider:
    """
    Fournisseur de recommandations. Sous-classe = une IA. La logique commune
    (montage du prompt, retry avec backoff sur erreur passagère, extraction du
    JSON) vit ici ; chaque sous-classe n'implémente que l'appel HTTP `_call`.
    """

    name = "provider"
    RETRIES = 2         # tentatives supplémentaires sur erreur passagère
    BACKOFF = 1.5       # secondes, croissant

    def available(self):
        return bool(getattr(self, "api_key", None))

    def recommend(self, criteria, excluded, keywords=""):
        """
        Retourne [{title, year, description}] (≤ 3) ou lève AdvisorError.
        Sur erreur passagère : retente ; sinon échoue (l'orchestrateur passe au
        fournisseur suivant).
        """
        if not self.available():
            raise AdvisorError(f'{self.name}: no API key')
        prompt = PROMPT.format(
            criteria=_format_criteria(criteria),
            extra=_format_extra(keywords),
            excluded="\n".join(excluded) if excluded else "(none)",
        )
        last = None
        for attempt in range(self.RETRIES + 1):
            try:
                text = self._call(prompt)
            except _Transient as err:
                last = err
                print(f"[Advisor] {self.name} indispo (essai {attempt + 1}) : {err}")
                if attempt < self.RETRIES:
                    time.sleep(self.BACKOFF * (attempt + 1))
                    continue
                raise AdvisorError(str(err))
            recs = _parse(text)
            if not recs:
                print(f"[Advisor] {self.name} JSON illisible : {str(text)[:200]}")
                raise AdvisorError(f'{self.name} returned unreadable JSON.')
            return recs[:3]
        raise AdvisorError(str(last))

    def _call(self, prompt):
        """Envoie le prompt, retourne le texte du modèle. Lève _Transient
        (passager) ou AdvisorError (permanent). À implémenter par la sous-classe."""
        raise NotImplementedError


class Gemini(Provider):
    """
    Client Gemini (generateContent). JSON demandé explicitement (responseMimeType).
    La clé voyage dans l'en-tête x-goog-api-key, jamais en paramètre d'URL (sinon
    elle fuite dans les messages d'erreur de requests, qui recopient l'URL).
    """

    name = "Gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta"

    def __init__(self, api_key, model=None):
        self.api_key = api_key
        self.model = model or "gemini-2.5-flash"

    def _call(self, prompt):
        try:
            resp = requests.post(
                f"{self.BASE}/models/{self.model}:generateContent",
                headers={"x-goog-api-key": self.api_key},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "responseMimeType": "application/json",
                        "temperature": 1.0,
                    },
                },
                timeout=25,
            )
        except requests.RequestException as err:
            raise _Transient(f'network: {err}') from err
        if resp.status_code in _TRANSIENT_CODES:
            raise _Transient(f'{resp.status_code}: {_api_error(resp)}')
        if resp.status_code != 200:
            raise AdvisorError(_api_error(resp))  # permanent (clé, quota…)
        try:
            return resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise AdvisorError(f'{self.name}: unexpected answer')


class OpenAICompatible(Provider):
    """
    Fournisseur générique parlant le dialecte OpenAI `/chat/completions` :
    xAI (Grok), Groq, OpenRouter, Mistral, Cerebras… Configuré par (base, clé,
    modèle). `json_mode` demande une réponse JSON native ; si un modèle ne le
    gère pas, le mettre à false (le prompt + _parse suffisent alors).
    """

    def __init__(self, name, base_url, api_key, model, json_mode=True):
        self.name = name or "OpenAI-compatible"
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key
        self.model = model
        self.json_mode = json_mode

    def available(self):
        return bool(self.api_key and self.base_url and self.model)

    def _call(self, prompt):
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 1.0,
        }
        if self.json_mode:
            payload["response_format"] = {"type": "json_object"}
        try:
            resp = requests.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=25,
            )
        except requests.RequestException as err:
            raise _Transient(f'network: {err}') from err
        if resp.status_code in _TRANSIENT_CODES:
            raise _Transient(f'{resp.status_code}: {_openai_error(resp)}')
        if resp.status_code != 200:
            raise AdvisorError(f'{self.name}: {_openai_error(resp)}')
        try:
            return resp.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise AdvisorError(f'{self.name}: unexpected answer')


class Advisor:
    """
    Orchestrateur : essaie les fournisseurs dans l'ordre jusqu'au premier succès.
    Un fournisseur en panne (surcharge, quota, réseau) laisse la place au suivant
    — c'est le vrai filet de sécurité quand une IA gratuite est indisponible.
    """

    def __init__(self, providers):
        self.providers = [p for p in providers if p is not None]

    def available(self):
        return any(p.available() for p in self.providers)

    def names(self):
        return [p.name for p in self.providers if p.available()]

    def recommend(self, criteria, excluded, keywords=""):
        last = None
        for p in self.providers:
            if not p.available():
                continue
            try:
                recs = p.recommend(criteria, excluded, keywords)
                print(f"[Advisor] Recommandations via {p.name}")
                return recs
            except AdvisorError as err:
                last = err
                print(f"[Advisor] {p.name} échoue ({err}) → fournisseur suivant")
        raise last or AdvisorError("No advisor provider configured.")


def clip_summary(text, limit=140):
    """
    Raccourcit un résumé trop long, sur une frontière de mot.

    Le modèle vise 120 caractères mais dépasse régulièrement de ~10 % (il compte
    mal). L'écran tient 6 lignes ; au-delà on coupe ici plutôt que de laisser le
    CSS trancher au milieu d'un mot.
    """
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(" ,;:")
    return f"{cut}…"


def _api_error(resp):
    """Extrait le message d'erreur de Google (jamais l'URL : elle porte la clé)."""
    try:
        message = (resp.json().get('error') or {}).get('message')
    except ValueError:
        message = None
    if not message:
        return f'Gemini error {resp.status_code}.'
    return message.split('. Learn more')[0].strip()


def _openai_error(resp):
    """Message d'erreur d'une API de style OpenAI (xAI, Groq, OpenRouter…)."""
    try:
        body = resp.json()
        err = body.get('error')
        message = err.get('message') if isinstance(err, dict) else (err or body.get('message'))
    except ValueError:
        message = None
    return (message or f'error {resp.status_code}').strip()[:200]


def _format_criteria(criteria):
    """Critères -> lignes « Mood: Mystery ». « Any » = pas de contrainte, omis."""
    lines = []
    for key, label in CRITERIA_LABELS.items():
        value = (criteria or {}).get(key)
        if value and value != "Any":
            lines.append(f"{label}: {value}")
    return "\n".join(lines) if lines else "No preference (surprise the user)"


def _format_extra(keywords):
    """
    Champ libre -> bloc « Additional request » injecté dans le prompt, ou chaîne
    vide s'il n'y a rien. Une longueur maximale évite qu'un collage aberrant ne
    gonfle la requête. Le texte est laissé tel quel (l'utilisateur écrit ce qu'il
    veut : acteur, réalisateur, ambiance…).
    """
    kw = (keywords or "").strip()[:200]
    if not kw:
        return ""
    return f"\nAdditional request from the user (take it into account):\n{kw}\n"


def _parse(text):
    """
    Extrait la liste de recommandations du texte du modèle.

    responseMimeType nous donne normalement du JSON nu, mais un modèle peut
    toujours l'emballer dans un bloc ```json — d'où le repli sur le premier
    objet accoladé trouvé.
    """
    for candidate in (text, _first_json_object(text)):
        if not candidate:
            continue
        try:
            data = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        recs = data.get("recommendations") if isinstance(data, dict) else None
        if isinstance(recs, list) and recs:
            return [r for r in recs if isinstance(r, dict) and r.get("title")]
    return None


def _first_json_object(text):
    match = re.search(r"\{.*\}", str(text), re.DOTALL)
    return match.group(0) if match else None
