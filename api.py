from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os

app = Flask(__name__)
CORS(app) # Autorise les appels depuis le navigateur

SAVE_FILE = "/home/tv/app_tv/progression.json"

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
    
    # Tout doit se passer tant que le fichier est ouvert (dans le bloc 'with')
    with open(SAVE_FILE, 'w') as f:
        json.dump(data, f)
        
        f.flush()
        os.fsync(f.fileno())
    
    # Ici le fichier est fermé proprement, on peut répondre au navigateur
    return jsonify({"status": "ok"})

if __name__ == '__main__':
    # Tourne sur le port 5000
    app.run(host='0.0.0.0', port=5000)
