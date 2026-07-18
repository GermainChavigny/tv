/**
 * Weather Icons
 * Icônes météo SVG (pas d'emoji : ils rendent en « tofu » dans la police mono)
 * et libellés, partagés entre l'icône d'en-tête (Weather.js) et la popup de
 * prévisions (WeatherPopup.js). Les codes sont des codes météo WMO d'Open-Meteo.
 */

/** Code WMO → catégorie d'icône. */
export function categoryOf(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 71 && code <= 77) return 'snow';
  if (code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'thunder';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  return 'cloud';
}

/** Libellé court style « décodeur » à partir d'un code WMO. */
export function conditionLabel(code) {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code >= 95) return "T'storms";
  return 'Cloudy';
}

// Fragments SVG (viewBox 0 0 24 24). Les classes wi-* sont colorées en CSS.
const CLOUD = '<path class="wi-cloud" d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 18 18H7z"/>';
const SUN_RAYS = '<g class="wi-sun-rays"><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M20 4l-2 2M6 18l-2 2"/></g>';

const ICONS = {
  sun: `<circle class="wi-sun" cx="12" cy="12" r="5"/>${SUN_RAYS}`,
  partly: `<circle class="wi-sun" cx="9" cy="8" r="3.5"/>${CLOUD}`,
  cloud: CLOUD,
  fog: `${CLOUD}<g class="wi-fog"><path d="M4 21h16M6 23.5h12"/></g>`,
  rain: `${CLOUD}<g class="wi-rain"><path d="M8 20l-1 2.5M13 20l-1 2.5M18 20l-1 2.5"/></g>`,
  snow: `${CLOUD}<g class="wi-snow"><circle cx="8" cy="21.5" r="1"/><circle cx="13" cy="21.5" r="1"/><circle cx="18" cy="21.5" r="1"/></g>`,
  thunder: `${CLOUD}<path class="wi-bolt" d="M12 19l-3 4h2.2L10 26l4-5h-2.3l1.3-2z"/>`,
};

/** SVG d'une catégorie (`sun`, `rain`…). */
export function iconSvg(category) {
  return `<svg class="wi wi-${category}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[category] || ICONS.cloud}</svg>`;
}

/** SVG directement à partir d'un code WMO. */
export function iconForCode(code) {
  return iconSvg(categoryOf(code));
}
