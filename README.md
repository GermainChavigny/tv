# 📺 TV App

Application de gestion TV avec contrôle des chaînes, alarme, et lecture de films.

## 🚀 Installation Rapide

### Prérequis
- Python 3.8+
- Navigateur moderne avec support ES6 modules

### Setup Windows (Développement)

```bash
# 1. Installer dépendances Python
pip install -r requirements.txt

# 2. Démarrer le backend (terminal 1)
python api.py
# Backend tourne sur http://localhost:5000

# 3. Démarrer le frontend (terminal 2)
python -m http.server 8000
# Frontend accessible sur http://localhost:8000

# 4. Ouvrir navigateur
# http://localhost:8000
```

### Setup Debian (Production)

```bash
# Sur la machine cible (mini PC Debian)
cd /home/tv/app_tv/

# Installer dépendances
pip install -r requirements.txt

# Démarrer le backend
python api.py &

# Servir le frontend (ou utiliser nginx)
python -m http.server 8000 &

# Pour persistence systemd, créer un service (voir ci-dessous)
```

### Service Systemd (Debian)

Créer `/etc/systemd/system/tv-app.service`:
```ini
[Unit]
Description=TV App
After=network.target

[Service]
Type=simple
User=tv
WorkingDirectory=/home/tv/app_tv
ExecStart=/usr/bin/python3 api.py
Restart=always

[Install]
WantedBy=multi-user.target
```

Puis:
```bash
sudo systemctl enable tv-app
sudo systemctl start tv-app
```

## 🔧 Configuration

### Gestion des Données

Les données (progression, alarmes, etc.) sont stockées dans un dossier **externe au dépôt git** (`../tv_data/`) pour éviter les conflits lors des mises à jour.

Le dossier `tv_data` est créé automatiquement au démarrage du backend s'il n'existe pas. Aucune configuration d'environnement n'est requise.

**Structure:**
```
tv/
  tv_app/           # Dépôt git
  tv_data/          # Données persistantes (hors git)
    progression.json
    movies_progress.json
    alarm.json
```

### config.js

Modifier `config.js` pour customiser les URLs d'API:
```javascript
const config = {
  api: {
    host: 'http://localhost:5000',  // URL du backend
    ...
  },
  hardware: {
    tvControl: 'http://192.168.1.19/rpc/Switch.Set', // IP de la prise intelligente
  },
};
```

## 🐛 Troubleshooting

| Problème | Solution |
|----------|----------|
| Backend ne démarre | `pip install -r requirements.txt` |
| Frontend blanc | Console (F12): chercher erreurs |
| Chaînes ne chargent pas | Attendre 3s + F5 (YouTube API) |
| Port 5000 utilisé | `lsof -i :5000` ou déterminer autre port |
| Données non sauvegardées | Vérifier que `../tv_data/` est accessible |
| Clavier ne répond pas | Vérifier console (F12) pour erreurs |

## 🔍 Débugging

```javascript
// Console (F12)
window.tvApp.state.getState()           // État actuel
window.tvApp.playerManager              // Player API
window.tvApp.alarmManager               // Alarm API
window.tvApp.keyboardHandler            // Keyboard events
```

## 📡 API Backend

```
GET  /health                    # Santé du service
GET  /load                      # Charger progression
POST /save                      # Sauvegarder progression
GET  /movies-list               # Liste des films
POST /movies-progress           # Sauvegarder position film
```

## 🚀 Déploiement

1. Clone repo sur `/home/tv/app_tv/`
2. Créer dossier de données: `mkdir -p ../tv_data` (au niveau parent du git)
3. `pip install -r requirements.txt`
4. Configurer IP prise Shelly dans `config.js`
5. Créer service systemd (voir Setup Debian)
6. Accéder via navigateur (http://mini-pc-ip:8000)

