from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import json
import os
from pathlib import Path
import requests

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
SAVE_FILE = os.path.join(DATA_DIR, 'progression.json')
MOVIES_SAVE_FILE = os.path.join(DATA_DIR, 'movies_progress.json')
ALARM_FILE = os.path.join(DATA_DIR, 'alarm.json')
TV_CONTROL_URL = 'http://192.168.1.19/rpc/Switch.Set'

print(f"[TV App] Data directory: {DATA_DIR}")
print(f"[TV App] Movies directory: {MOVIES_DIR}")
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

# --- SERVIR UN FICHIER VIDÉO ---
@app.route('/get-movie/<filename>', methods=['GET'])
def get_movie(filename):
    """Serve a movie file from the movies directory"""
    try:
        # Security: ensure filename doesn't contain path traversal
        if '..' in filename or '/' in filename or '\\' in filename:
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
        "data_dir": DATA_DIR
    })

if __name__ == '__main__':
    # Tourne sur le port 5000
    # 0.0.0.0 pour accepter les connexions depuis n'importe où
    app.run(host='0.0.0.0', port=5000, debug=False)
