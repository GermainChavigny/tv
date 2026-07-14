/**
 * Retro Clock
 * Met à jour toutes les `.crt-clock` (HH:MM) et `.crt-date` (DD MON YYYY) du DOM
 * chaque seconde. Un seul timer partagé par tous les overlays films.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function tick() {
  const now = new Date();
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const date = `${pad(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  for (const el of document.querySelectorAll('.crt-clock')) el.textContent = time;
  for (const el of document.querySelectorAll('.crt-date')) el.textContent = date;
}

export function startRetroClock() {
  tick();
  return setInterval(tick, 1000);
}

export default startRetroClock;
