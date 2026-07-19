/**
 * Retro Cursor
 * Le curseur natif est masqué (html { cursor: none }). Ce module dessine à la
 * place une IMAGE pixel qui suit la souris. L'intérêt par rapport au curseur CSS
 * `url(...)` : on choisit librement la taille (le curseur système était plafonné
 * par l'OS/serveur X, d'où la flèche qui ne s'affichait pas au-delà de ~48 px).
 *
 * Taille : pilotée par la variable CSS `--cursor-size` (:root), en `vw` comme
 * tout le reste de l'UI. On ne lit jamais sa valeur en JS : la taille et le
 * décalage du hotspot sont exprimés en CSS (`var(--cursor-size)` + `calc()`),
 * donc c'est le navigateur qui résout le vw. Un seul chiffre à changer, et les
 * hotspots suivent l'échelle automatiquement.
 *
 * Quelle image afficher ? On lit la custom property héritée `--cur` de l'élément
 * sous le pointeur : les cliquables portent `--cur: hand`, le reste `--cur: arrow`.
 * Pas de liste de sélecteurs à maintenir en JS : l'héritage CSS fait le travail.
 */

// Source des PNG (32×32). hotspot = pixel « actif » dans l'image source.
const SRC_PX = 32;
const CURSORS = {
  arrow: { src: 'cursors/cursor.png', hotspot: [0, 0] }, // flèche : pointe en bas
  hand: { src: 'cursors/pointer.png', hotspot: [15, 0] }, //  main  : doigt en haut
};

export function startRetroCursor() {
  // Taille en vw (repli si --cursor-size absente). Le navigateur résout le vw.
  const SIZE = 'var(--cursor-size, 5vw)';

  const layer = document.createElement('div');
  layer.id = 'retro-cursor';
  Object.assign(layer.style, {
    position: 'fixed', left: '0', top: '0',
    width: SIZE, height: SIZE,
    zIndex: '2000', // au-dessus de tout (OSD volume compris)
    pointerEvents: 'none', // laisse passer les clics ET elementFromPoint
    imageRendering: 'pixelated', // pixels nets, pas de flou à l'agrandissement
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${SIZE} ${SIZE}`,
    display: 'none', // caché tant que la souris n'a pas bougé
    willChange: 'transform',
  });
  document.body.appendChild(layer);

  // Précharge les deux images (évite un flash au premier survol d'un bouton).
  Object.values(CURSORS).forEach((c) => { const i = new Image(); i.src = c.src; });

  let x = 0, y = 0, kind = 'arrow';
  let lastEl = null, lastCur = 'arrow';

  // Masquage auto après inactivité (comme une TV : le pointeur s'efface tout
  // seul, notamment pendant un film). Se réaffiche au moindre mouvement.
  const IDLE_MS = 3000;
  let idleTimer = null;
  const hide = () => { layer.style.display = 'none'; };
  const show = () => { if (layer.style.display === 'none') layer.style.display = 'block'; };

  function draw() {
    const c = CURSORS[kind] || CURSORS.arrow;
    layer.style.backgroundImage = `url("${c.src}")`;
    // Décale l'image pour que son hotspot tombe pile sur les coordonnées souris.
    // Le hotspot est une fraction de la taille (source 32 px), résolue en CSS via
    // calc() → suit le vw sans que le JS n'ait à convertir quoi que ce soit.
    const hx = c.hotspot[0] / SRC_PX, hy = c.hotspot[1] / SRC_PX;
    layer.style.transform =
      `translate(calc(${x}px - ${hx} * ${SIZE}), calc(${y}px - ${hy} * ${SIZE}))`;
  }

  window.addEventListener('mousemove', (e) => {
    x = e.clientX; y = e.clientY;
    // Recalcule --cur seulement quand l'élément survolé change (économie).
    const el = document.elementFromPoint(x, y);
    if (el !== lastEl) {
      lastEl = el;
      lastCur = el
        ? (getComputedStyle(el).getPropertyValue('--cur').trim() || 'arrow')
        : 'arrow';
    }
    kind = lastCur === 'hand' ? 'hand' : 'arrow';
    show();
    draw();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(hide, IDLE_MS);
  }, { passive: true });

  // Souris hors de la fenêtre → on cache l'image (sinon elle resterait figée).
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) hide(); });

  return layer;
}

export default startRetroCursor;
