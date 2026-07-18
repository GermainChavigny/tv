/**
 * Pied de page rétro commun : raccourcis « [MOVIES] [SEARCH] [ADVISOR] » à
 * gauche (toujours présents) + zone d'actions spécifiques à l'écran à droite.
 */

// Destination d'un raccourci -> événement émis. Les trois carrés colorés sont
// stylés par .nav-sq.nav-* (ambre / vert / cyan).
const NAV_EVENTS = {
  library: 'nav-library',
  search: 'nav-search',
  advisor: 'nav-advisor',
};

/** HTML du pied ; `actionsHtml` = boutons spécifiques à l'écran (droite). */
export function footerHtml(actionsHtml = '') {
  return `
    <div class="crt-footer">
      <span class="crt-shortcuts">
        <button class="crt-navbtn" data-nav="library" type="button"><span class="nav-sq nav-movies">■</span> Movies</button>
        <button class="crt-navbtn" data-nav="search" type="button"><span class="nav-sq nav-search">■</span> Search</button>
        <button class="crt-navbtn" data-nav="advisor" type="button"><span class="nav-sq nav-advisor">■</span> Advisor</button>
      </span>
      <span class="crt-actions">${actionsHtml}</span>
    </div>`;
}

/**
 * Câble les raccourcis : émet 'nav-library' / 'nav-search' / 'nav-advisor' sur
 * `emitter` (app.js les relie à l'ouverture de l'écran correspondant).
 */
export function wireFooterNav(root, emitter) {
  root.querySelectorAll('.crt-footer [data-nav]').forEach((btn) => {
    const event = NAV_EVENTS[btn.dataset.nav];
    if (!event) return;
    btn.addEventListener('click', () => emitter.emit(event));
  });
}
