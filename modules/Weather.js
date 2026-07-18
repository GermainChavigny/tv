/**
 * Weather
 * Prévision de Tours à l'heure suivante, affichée en petite icône à côté de la
 * date dans les en-têtes rétro. Les données viennent de notre backend (proxy
 * Open-Meteo, gratuit et sans clé). Un clic sur l'icône/la date ouvre la popup
 * de prévisions du jour (voir WeatherPopup.js).
 *
 * Un seul fetch partagé, rafraîchi toutes les 15 min ; remplit toutes les
 * `.crt-weather` du DOM, comme RetroClock le fait pour l'heure.
 */

import { apiClient } from './ApiClient.js';
import { categoryOf, conditionLabel, iconSvg } from './WeatherIcons.js';

const REFRESH_MS = 15 * 60 * 1000;

async function refresh() {
  let data;
  try {
    data = await apiClient.getWeather();
  } catch {
    return; // silencieux : la météo est décorative, on retentera au prochain tour
  }
  if (!data || typeof data.code !== 'number') return;
  const html = iconSvg(categoryOf(data.code));
  for (const el of document.querySelectorAll('.crt-weather')) {
    el.innerHTML = html;
    el.title = `${conditionLabel(data.code)} · ${data.hour || ''}`;
  }
}

export function startWeather() {
  refresh();
  return setInterval(refresh, REFRESH_MS);
}

export default startWeather;
