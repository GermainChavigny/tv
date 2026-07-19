/**
 * Movie Advisor
 * Écran de recommandation : on choisit des critères (humeur, époque, thème…),
 * un moteur IA propose 3 films, chacun se branche sur la recherche torrent.
 * Look décodeur rétro, tout au curseur.
 *
 * Un seul overlay, deux axes indépendants (le picker doit laisser l'écran des
 * critères visible dessous, donc ce n'est pas une 3ᵉ vue) :
 *   - vue principale : root.dataset.view = 'criteria' | 'recs'
 *   - modal picker   : classe 'picking' sur la racine
 *
 * L'état (critères + recommandations + vue) n'est JAMAIS réinitialisé : close()
 * ne retire que la classe 'open' et open() restaure la vue courante. C'est ce
 * qui permet d'aller télécharger une reco puis de revenir sur les 3 autres.
 *
 * Émet :
 *   'search-movie' ({query})      lancer la recherche torrent d'une reco
 *   'nav-library' / 'nav-search' / 'nav-advisor'   raccourcis (via CrtFooter)
 */

import { EventEmitter } from './EventEmitter.js';
import { footerHtml, wireFooterNav } from './CrtFooter.js';
import { QUOTES } from './AdvisorQuotes.js';
import { reveal } from './RetroFx.js';

// Les thèmes, partagés par référence entre Theme 1 et Theme 2.
const THEMES = [
  'Western', 'Space', 'Sci-Fi', 'Fantasy', 'Medieval', 'War', 'Crime', 'Detective',
  'Horror', 'Creatures', 'Monsters', 'Zombies', 'Vampires', 'Robots', 'AI', 'Cyberpunk',
  'Post-apocalyptic', 'Time Travel', 'Superheroes', 'Martial Arts', 'Pirates', 'Samurai',
  'Espionage', 'Nature', 'Survival', 'Ocean', 'Mountains', 'Desert', 'Jungle', 'Arctic',
  'Documentary',
  // Genres & registres
  'Heist', 'Gangster', 'Film Noir', 'Thriller', 'Slasher', 'Disaster', 'Musical',
  'Sports', 'Boxing', 'Racing', 'Courtroom', 'Political', 'Biopic', 'Historical',
  'Coming-of-Age', 'Road Trip', 'Prison', 'Con Artists', 'Revenge', 'Kidnapping',
  // Univers & créatures
  'Dystopia', 'Steampunk', 'Mythology', 'Dragons', 'Vikings', 'Gladiators', 'Knights',
  'Wizards', 'Witches', 'Demons', 'Ghosts', 'Aliens', 'Kaiju', 'Mecha', 'Dinosaurs',
  'Magic', 'Assassins', 'Ninjas', 'Hackers', 'Treasure Hunt', 'Cars', 'Music', 'Dance',
  'Family', 'Christmas',
];

/**
 * Les 8 critères. `options[0]` est TOUJOURS « Any » : c'est la valeur par
 * défaut et l'échappatoire depuis le picker (d'où l'absence de bouton retour).
 */
export const CRITERIA = [
  { key: 'mood', label: 'Mood', options: ['Any', 'Relax', 'Think', 'Laugh', 'Cry', 'Adrenaline', 'Mystery', 'Romance', 'Dark'] },
  { key: 'pace', label: 'Pace', options: ['Any', 'Fun', 'Serious', 'Epic', 'Weird', 'Cozy', 'Tense'] },
  { key: 'era', label: 'Era', options: ['Any', '< 70s', '70s', '80s', '90s', '2000s', '2010+'] },
  { key: 'scale', label: 'Scale', options: ['Any', 'Blockbuster', 'Mid-budget', 'Indie'] },
  { key: 'rating', label: 'Rating', options: ['Any', 'Must watch', 'Great', 'Hidden gem'] },
  { key: 'length', label: 'Length', options: ['Any', '< 90 min', '90–120 min', '> 120 min'] },
  { key: 'theme1', label: 'Theme 1', options: ['Any', ...THEMES] },
  { key: 'theme2', label: 'Theme 2', options: ['Any', ...THEMES] },
];

// Au-delà de ce nombre d'options, le picker passe de 2 à 3 colonnes.
const COMPACT_MAX = 4;

/** Valeurs par défaut dérivées de CRITERIA (jamais écrites à la main). */
function defaultValues() {
  return Object.fromEntries(CRITERIA.map((c) => [c.key, 'Any']));
}

const byKey = (key) => CRITERIA.find((c) => c.key === key);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class MovieAdvisor extends EventEmitter {
  constructor(apiClient) {
    super();
    this.apiClient = apiClient;
    this.root = null;
    this.isOpen = false;

    // --- État persistant : survit à close()/open() tant que l'app tourne. ---
    this.view = 'criteria';
    this.values = defaultValues();
    this.keywords = ''; // champ libre ajouté au prompt (acteur, thème…)
    this.recommendations = [];

    // --- État volatil. ---
    this.pickerKey = null;
    this.busy = false;
  }

  init() {
    const root = document.createElement('div');
    root.id = 'movie-advisor';
    root.dataset.view = 'criteria';
    root.innerHTML = `
      <div class="crt-header">
        <span class="crt-title">Movie Advisor</span>
        <span class="crt-meta"></span>
        <span class="crt-clock-wrap"><span class="crt-clock"></span><span class="crt-weather"></span><span class="crt-date"></span></span>
      </div>

      <div class="adv-view adv-criteria">
        <div class="adv-critic">
          <div class="adv-photo"><img src="img/advisor-critic.gif" draggable="false" alt="" /></div>
          <div class="adv-name">Michael Harper</div>
          <div class="adv-role">Movie Advisor</div>
          <div class="adv-quote"></div>
          <button class="crt-btn adv-keywords" type="button"></button>
        </div>
        <div class="adv-col">
          <div class="adv-grid"></div>
          <div class="adv-actions">
            <button class="crt-btn adv-surprise" type="button">Surprise</button>
            <button class="crt-btn adv-go" type="button">Search</button>
          </div>
        </div>
      </div>

      <div class="adv-view adv-recs"></div>
      <div class="adv-msg"></div>

      <div class="adv-modal">
        <div class="adv-picker">
          <div class="adv-pk-head"><span class="adv-pk-title"></span></div>
          <div class="adv-pk-grid"></div>
        </div>
      </div>

      ${footerHtml('<button class="crt-navbtn adv-back" type="button">[Back]</button>')}
    `;
    document.body.appendChild(root);

    this.root = root;
    this.metaEl = root.querySelector('.crt-meta');
    this.quoteEl = root.querySelector('.adv-quote');
    this.gridEl = root.querySelector('.adv-grid');
    this.recsEl = root.querySelector('.adv-recs');
    this.msgEl = root.querySelector('.adv-msg');
    this.modalEl = root.querySelector('.adv-modal');
    this.pickerEl = root.querySelector('.adv-picker');
    this.pkTitleEl = root.querySelector('.adv-pk-title');
    this.pkGridEl = root.querySelector('.adv-pk-grid');
    this.keywordsBtn = root.querySelector('.adv-keywords');

    // L'affiche du critique peut manquer (fichier non fourni) → cadre vide.
    const photo = root.querySelector('.adv-photo');
    const photoImg = photo.querySelector('img');
    photoImg.addEventListener('error', () => photo.classList.add('no-poster'));

    wireFooterNav(root, this);
    root.querySelector('.adv-back').addEventListener('click', () => this._setView('criteria'));
    root.querySelector('.adv-surprise').addEventListener('click', () => this._surprise());
    root.querySelector('.adv-go').addEventListener('click', () => this._run());
    // Champ libre : app.js ouvre le clavier virtuel et rappelle setKeywords().
    this.keywordsBtn.addEventListener('click', () => this.emit('edit-keywords'));

    // Un critère → ouvre son picker.
    this.gridEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.adv-crit');
      if (btn) this._openPicker(btn.dataset.key);
    });

    // Une option → sauvegarde et ferme aussitôt.
    this.pkGridEl.addEventListener('click', (e) => {
      const opt = e.target.closest('.adv-opt');
      if (!opt || !this.pickerKey) return;
      this.values[this.pickerKey] = opt.dataset.val;
      this._renderCriteria();
      this._closePicker();
    });

    // Clic sur le fond assombri (et non sur le panneau) → ferme sans changer.
    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this._closePicker();
    });

    this._renderCriteria();
    this._renderKeywords();
    return this;
  }

  /** Reflète le champ libre sur son bouton (valeur ou invite). */
  _renderKeywords() {
    const kw = this.keywords.trim();
    this.keywordsBtn.textContent = kw ? kw : '+ KEYWORDS';
    this.keywordsBtn.classList.toggle('is-set', !!kw);
  }

  /** Reçoit le texte saisi au clavier virtuel (appelé par app.js). */
  setKeywords(text) {
    this.keywords = (text || '').trim();
    this._renderKeywords();
  }

  open() {
    this._closePicker();
    this.quoteEl.textContent = `« ${pick(QUOTES)} »`;
    this._renderCriteria();
    this._renderKeywords();
    // Restaure la vue quittée (les recos sont conservées) ; s'il n'y a rien à
    // montrer — jamais lancé, ou dernier appel en erreur — repart des critères.
    this._setView(this.recommendations.length ? this.view : 'criteria');
    this.isOpen = true;
    this.root.classList.add('open');
  }

  close() {
    this.isOpen = false;
    this._closePicker();
    this.root.classList.remove('open'); // ne touche AUCUN état persistant
  }

  toggle() {
    return this.isOpen ? this.close() : this.open();
  }

  _setView(view) {
    this.view = view;
    this.root.dataset.view = view;
    const left = this.recommendations.filter(Boolean).length; // les « Forget » ne comptent plus
    this.metaEl.textContent = view === 'recs' && left ? `${left} picks` : '';
  }

  _openPicker(key) {
    const crit = byKey(key);
    if (!crit) return;
    this.pickerKey = key;
    this.pkTitleEl.textContent = crit.label;
    this.pickerEl.classList.toggle('is-compact', crit.options.length <= COMPACT_MAX);

    const current = this.values[key];
    this.pkGridEl.innerHTML = crit.options.map((opt) => {
      const cls = ['crt-btn', 'adv-opt'];
      if (opt === 'Any') cls.push('is-any');
      if (opt === current) cls.push('is-active');
      return `<button class="${cls.join(' ')}" type="button" data-val="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`;
    }).join('');

    this.pkGridEl.scrollTop = 0;
    this.root.classList.add('picking');
    // Cascade rétro sur les options à l'ouverture du picker.
    reveal(this.pkGridEl, { selector: '.adv-opt' });
  }

  _closePicker() {
    this.pickerKey = null;
    if (this.root) this.root.classList.remove('picking');
  }

  /** Les 8 boutons de critères : nom + valeur courante. */
  _renderCriteria() {
    this.gridEl.innerHTML = CRITERIA.map((c) => `
      <button class="crt-btn adv-crit" type="button" data-key="${c.key}">
        <span class="adv-crit-name">${escapeHtml(c.label)}</span>
        <span class="adv-crit-val">${escapeHtml(this.values[c.key])}</span>
      </button>
    `).join('');
  }

  /** Une valeur au hasard pour chaque critère — « Any » inclus dans le tirage. */
  _surprise() {
    for (const c of CRITERIA) this.values[c.key] = pick(c.options);
    this._renderCriteria();
  }

  /**
   * Message affiché à la place des recommandations (chargement, erreur, vide).
   * `null` rend la main à la grille.
   */
  _message(text) {
    this.msgEl.textContent = text || '';
    this.root.classList.toggle('is-msg', !!text);
  }

  /** Appelle le moteur et bascule sur les recommandations. */
  async _run() {
    if (this.busy) return;
    this.busy = true;
    this.recommendations = [];
    this._setView('recs');
    this._message('Consulting Michael Harper…');

    let recs;
    try {
      recs = await this.apiClient.adviseMovies(this.values, this.keywords);
    } catch (err) {
      this.busy = false;
      // Le backend relaie le message de Google (quota, clé…) : le montrer plutôt
      // que de laisser deviner la cause.
      this._message(`Advisor unavailable — ${err.message || 'unknown error'}`);
      return;
    }
    this.busy = false;

    if (!recs || !recs.length) {
      this._message('No picks this time. Try loosening a criterion.');
      return;
    }
    this.recommendations = recs;
    this._renderRecs();
    this._message(null); // rend la main à la grille
    this._setView('recs'); // re-pose la vue : le compteur « N picks » a besoin des recos
  }

  /** Les 3 colonnes (largeurs strictement égales via repeat(3, 1fr)). */
  _renderRecs() {
    this.recsEl.innerHTML = '';
    this.recommendations.forEach((movie, idx) => {
      const col = document.createElement('div');
      col.className = 'adv-rec';

      // Emplacement écarté : garde la colonne pour ne pas casser la grille.
      if (!movie) {
        col.classList.add('is-empty');
        col.textContent = '— Forgotten —';
        this.recsEl.appendChild(col);
        return;
      }

      col.innerHTML = `
        <div class="adv-rec-poster">${movie.posterUrl ? '<img draggable="false" alt="" />' : ''}</div>
        <div class="adv-rec-title">${escapeHtml(movie.title)}</div>
        <div class="adv-rec-year">${escapeHtml(String(movie.year || ''))}</div>
        <div class="adv-rec-acts">
          <button class="crt-btn adv-rec-go" type="button">Search</button>
          <button class="crt-btn adv-rec-no" type="button">Forget</button>
        </div>
        <div class="adv-rec-sum">${escapeHtml(movie.summary || '')}</div>
      `;

      if (movie.posterUrl) {
        const box = col.querySelector('.adv-rec-poster');
        const img = box.querySelector('img');
        img.addEventListener('error', () => box.classList.add('no-poster'));
        img.src = movie.posterUrl; // src après le listener : un 404 en cache tire aussitôt
      }
      col.querySelector('.adv-rec-go').addEventListener('click', () =>
        this.emit('search-movie', { query: movie.query || movie.title, movie }));
      col.querySelector('.adv-rec-no').addEventListener('click', () => this._forget(idx));

      this.recsEl.appendChild(col);
    });
  }

  /** FORGET : blacklist persistante + emplacement vidé sur place. */
  _forget(idx) {
    const movie = this.recommendations[idx];
    if (!movie) return;
    this.recommendations[idx] = null;
    this._renderRecs();
    this._setView('recs'); // rafraîchit le compteur « N picks »
    this.apiClient
      .forgetMovie({ id: movie.id, title: movie.title, year: movie.year })
      .catch((err) => console.warn('Advisor: forget failed:', err));
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default MovieAdvisor;
