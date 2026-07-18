/**
 * Retro FX
 * Renforce le thème « décodeur années 90 » :
 *   - fondu échelonné des éléments d'un écran à son ouverture (effet de
 *     chargement progressif),
 *   - petit « tick » sonore à chaque élément qui apparaît,
 *   - « bip » au clic de n'importe quel bouton.
 *
 * Les sons sont synthétisés à la volée (WebAudio) : aucun fichier, très courts
 * et discrets. L'AudioContext ne peut démarrer qu'après une interaction ; on le
 * réveille au premier clic (politique navigateur).
 */

// Éléments animés à l'ouverture d'un écran (dans l'ordre du DOM), plafonnés pour
// garder une cascade brève et un son non envahissant.
const REVEAL_SELECTOR = [
  '.crt-header', '.mb-row', '.ms-row', '.mc-row', '.mc-seek-wrap',
  '.vk-row', '.adv-critic', '.adv-crit', '.adv-actions .crt-btn',
  '.adv-keywords', '.mb-detail', '.ms-detail', '.crt-footer',
].join(',');
const MAX_ITEMS = 26;
const STEP_MS = 32;

let audio = null;
let masterGain = null;

function ensureAudio() {
  if (audio) {
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audio = new Ctx();
  masterGain = audio.createGain();
  masterGain.gain.value = 0.5;
  masterGain.connect(audio.destination);
}

/** Bip court synthétisé. `type` = 'click' | 'tick'. */
function blip(type) {
  if (!audio || audio.state !== 'running') return;
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  if (type === 'click') {
    osc.type = 'square';
    osc.frequency.value = 1180;
    gain.gain.value = 0.06;
  } else {
    osc.type = 'sine';
    osc.frequency.value = 720;
    gain.gain.value = 0.025;
  }
  // Enveloppe très courte (évite tout clic parasite).
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (type === 'click' ? 0.05 : 0.03));
  osc.connect(gain).connect(masterGain);
  osc.start(now);
  osc.stop(now + 0.06);
}

/**
 * Joue la cascade d'apparition sur les éléments d'un écran.
 * `animation-fill-mode: both` garantit que chaque élément FINIT visible même si
 * son délai est long — pas de risque d'élément coincé à opacity 0.
 */
export function revealOverlay(root) {
  if (!root) return;
  const items = [...root.querySelectorAll(REVEAL_SELECTOR)]
    .filter((el) => el.offsetParent !== null) // visibles seulement
    .slice(0, MAX_ITEMS);

  items.forEach((el, i) => {
    const delay = i * STEP_MS;
    el.style.animation = 'none';
    // Reflow pour pouvoir relancer l'animation à chaque ouverture.
    void el.offsetWidth;
    // steps(1, start) : pas de fondu progressif — l'élément reste invisible
    // pendant son délai puis APPARAÎT d'un coup (effet chargement rétro net).
    el.style.animation = `crt-reveal 0.08s steps(1, start) ${delay}ms both`;
    // Nettoyage : dès la fin (et via un filet de sécurité), on retire le style
    // inline pour que l'élément revienne à son opacité naturelle (1). Ainsi il
    // ne peut JAMAIS rester coincé invisible, même si 'animationend' ne part pas.
    const clear = () => { el.style.animation = ''; };
    el.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, delay + 500);
    // Un tick discret par élément (un sur deux pour ne pas saturer).
    if (i % 2 === 0) setTimeout(() => blip('tick'), delay);
  });
}

/**
 * Observe l'ajout de la classe `.open` sur chaque overlay et déclenche la
 * cascade. Un seul observer partagé, branché sur les racines fournies.
 */
export function startRetroFx(roots) {
  // Réveille l'audio + bip au clic d'un bouton OU d'une ligne sélectionnable
  // (film de la bibliothèque .mb-row / résultat de recherche .ms-row).
  document.addEventListener('click', (e) => {
    ensureAudio();
    if (e.target.closest('button, .mb-row, .ms-row')) blip('click');
  }, true);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName !== 'class') continue;
      const el = m.target;
      const wasOpen = m.oldValue ? m.oldValue.split(/\s+/).includes('open') : false;
      const isOpen = el.classList.contains('open');
      if (isOpen && !wasOpen) revealOverlay(el);
    }
  });

  for (const root of roots) {
    if (root) observer.observe(root, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
  }
  return observer;
}

export default startRetroFx;
