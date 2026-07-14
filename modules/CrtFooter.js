/**
 * Pied de page rétro commun : raccourcis « [MOVIES] [SEARCH] » à gauche
 * (toujours présents) + zone d'actions spécifiques à l'écran à droite.
 */

/** HTML du pied ; `actionsHtml` = boutons spécifiques à l'écran (droite). */
export function footerHtml(actionsHtml = '') {
  return `
    <div class="crt-footer">
      <span class="crt-shortcuts">
        <button class="crt-navbtn" data-nav="library" type="button"><span class="nav-sq nav-movies">■</span> Movies</button>
        <button class="crt-navbtn" data-nav="search" type="button"><span class="nav-sq nav-search">■</span> Search</button>
      </span>
      <span class="crt-actions">${actionsHtml}</span>
    </div>`;
}

/**
 * Câble les deux raccourcis : émet 'nav-library' / 'nav-search' sur `emitter`
 * (app.js les relie à l'ouverture de la bibliothèque / du clavier).
 */
export function wireFooterNav(root, emitter) {
  root.querySelectorAll('.crt-footer [data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      emitter.emit(btn.dataset.nav === 'search' ? 'nav-search' : 'nav-library');
    });
  });
}
