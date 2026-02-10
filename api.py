from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
from pathlib import Path
import requests

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})  # Allow all origins for all routes

# ============ CONFIGURATION ============
# Support pour variables d'environnement et détection automatique du système d'exploitation

def get_save_path():
    """
    Détecte le système d'exploitation et retourne le chemin approprié
    Windows: utilise des chemins locaux pour dev
    Linux/Debian: utilise les chemins /home/tv/...
    """
    if os.name == 'nt':  # Windows
        # Dev local sur Windows
        base_dir = Path(__file__).parent / 'data'
        base_dir.mkdir(exist_ok=True)
        return str(base_dir / 'progression.json'), str(base_dir / 'movies_progress.json'), str(base_dir / 'alarm.json')
    else:  # Linux/Debian
        # Production sur mini PC Debian
        return "/home/tv/app_tv/progression.json", "/home/tv/app_tv/movies_progress.json", "/home/tv/app_tv/alarm.json"

# Ou utiliser les variables d'environnement si définies
SAVE_FILE = os.getenv('TV_SAVE_FILE') or get_save_path()[0]
MOVIES_SAVE_FILE = os.getenv('TV_MOVIES_SAVE_FILE') or get_save_path()[1]
ALARM_FILE = os.getenv('TV_ALARM_FILE') or get_save_path()[2]
MOVIES_DIR = os.getenv('TV_MOVIES_DIR') or os.path.join(os.path.dirname(__file__), 'movies')
TV_CONTROL_URL = os.getenv('TV_CONTROL_URL') or 'http://192.168.1.19/rpc/Switch.Set'

# Émulation du matériel en dev
DEV_MODE = os.getenv('TV_DEV_MODE', 'false').lower() == 'true'

print(f"[TV App] OS: {os.name} | Save file: {SAVE_FILE} | Dev mode: {DEV_MODE}")
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
    
    # Créer les répertoires s'ils n'existent pas
    os.makedirs(os.path.dirname(SAVE_FILE), exist_ok=True)
    
    # Tout doit se passer tant que le fichier est ouvert (dans le bloc 'with')
    with open(SAVE_FILE, 'w') as f:
        json.dump(data, f)
        
        f.flush()
        os.fsync(f.fileno())
    
    # Ici le fichier est fermé proprement, on peut répondre au navigateur
    return jsonify({"status": "ok"})

# --- CHARGER LA PROGRESSION DES FILMS ---
@app.route('/movies-progress', methods=['GET'])
def load_movies_progress():
    if not os.path.exists(MOVIES_SAVE_FILE):
        return jsonify({}) # Retourne vide si pas de fichier
    try:
        with open(MOVIES_SAVE_FILE, 'r') as f:
            data = json.load(f)
        return jsonify(data)
    except:
        return jsonify({})

# --- SAUVEGARDER LA PROGRESSION DES FILMS ---
@app.route('/movies-progress', methods=['POST'])
def save_movies_progress():
    data = request.json
    
    # Créer les répertoires s'ils n'existent pas
    os.makedirs(os.path.dirname(MOVIES_SAVE_FILE), exist_ok=True)
    
    # Tout doit se passer tant que le fichier est ouvert (dans le bloc 'with')
    with open(MOVIES_SAVE_FILE, 'w') as f:
        json.dump(data, f)
        
        f.flush()
        os.fsync(f.fileno())
    
    # Ici le fichier est fermé proprement, on peut répondre au navigateur
    return jsonify({"status": "ok"})

# --- RÉCUPÉRER LA LISTE DES FICHIERS VIDÉO ---
@app.route('/movies-list', methods=['GET'])
def get_movies_list():
    if not os.path.exists(MOVIES_DIR):
        return jsonify([])
    
    try:
        # Récupérer tous les fichiers .mp4 dans le dossier movies
        files = [f for f in os.listdir(MOVIES_DIR) if f.lower().endswith('.mp4')]
        files.sort()
        return jsonify(files)
    except:
        return jsonify([])

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
    
    # Créer les répertoires s'ils n'existent pas
    os.makedirs(os.path.dirname(ALARM_FILE), exist_ok=True)
    
    # Tout doit se passer tant que le fichier est ouvert (dans le bloc 'with')
    with open(ALARM_FILE, 'w') as f:
        json.dump(data, f)
        
        f.flush()
        os.fsync(f.fileno())
    
    # Ici le fichier est fermé proprement, on peut répondre au navigateur
    print(f"[Alarm] Settings saved: {data}")
    return jsonify({"status": "ok"})

# --- HEALTH CHECK ---
@app.route('/health', methods=['GET'])
def health():
    """Endpoint de santé pour vérifier que l'API fonctionne"""
    return jsonify({
        "status": "ok",
        "version": "2.0",
        "environment": "production" if not DEV_MODE else "development"
    })

if __name__ == '__main__':
    # Tourne sur le port 5000
    # En dev: 0.0.0.0 pour accepter les connexions depuis n'importe où
    app.run(host='0.0.0.0', port=5000, debug=DEV_MODE)
