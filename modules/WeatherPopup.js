/**
 * Weather Popup
 * Popup de prévisions du jour, façon chaîne météo câblée des années 90 : badge
 * « WEATHER », en-tête « TOURS · TODAY » + horloge, trois panneaux bleus
 * (Morning / Afternoon / Evening) avec icône, condition et température, et une
 * barre de bas indiquant le min/max du jour.
 *
 * S'ouvre au clic sur l'icône météo ou la date/heure d'un en-tête (câblé dans
 * app.js). Les données viennent de /weather (mêmes que l'icône d'en-tête).
 */

import { apiClient } from './ApiClient.js';
import { iconForCode, conditionLabel } from './WeatherIcons.js';
import { reveal } from './RetroFx.js';

export class WeatherPopup {
  constructor() {
    this.root = null;
    this.isOpen = false;
  }

  init() {
    const root = document.createElement('div');
    root.id = 'weather-popup';
    root.innerHTML = `
      <div class="wp-frame">
        <div class="wp-head">
          <span class="wp-badge"><b>The</b>WEATHER<b>Channel</b></span>
          <span class="wp-title"><span>Tours&nbsp;Area</span><br>Today's&nbsp;Forecast</span>
          <span class="wp-clock crt-clock-wrap">
            <span class="crt-clock"></span>
            <span class="crt-date"></span>
          </span>
        </div>
        <div class="wp-panels"></div>
        <div class="wp-foot"></div>
      </div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.panelsEl = root.querySelector('.wp-panels');
    this.footEl = root.querySelector('.wp-foot');

    // Clic sur le fond (hors cadre) → ferme.
    root.addEventListener('click', (e) => { if (e.target === root) this.close(); });
    return this;
  }

  async toggle() {
    return this.isOpen ? this.close() : this.open();
  }

  async open() {
    this.isOpen = true;
    this.root.classList.add('open');
    let data;
    try {
      data = await apiClient.getWeather();
    } catch {
      data = null;
    }
    this.render(data);
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  render(data) {
    if (!data || !Array.isArray(data.periods)) {
      this.panelsEl.innerHTML = '<div class="wp-msg">Forecast unavailable</div>';
      this.footEl.textContent = '';
      return;
    }
    this.panelsEl.innerHTML = data.periods.map((p) => `
      <div class="wp-panel">
        <div class="wp-day">${escapeHtml(p.label)}</div>
        <div class="wp-icon">${iconForCode(p.code)}</div>
        <div class="wp-cond">${escapeHtml(conditionLabel(p.code))}</div>
        <div class="wp-temp">${Math.round(p.temp)}°</div>
      </div>
    `).join('');

    const day = data.day || {};
    const lo = day.lo != null ? `${Math.round(day.lo)}°` : '--';
    const hi = day.hi != null ? `${Math.round(day.hi)}°` : '--';
    this.footEl.innerHTML =
      `${escapeHtml(conditionLabel(day.code != null ? day.code : data.code))}` +
      `<span class="wp-lohi">Lo <b>${lo}</b>&nbsp;&nbsp;Hi <b>${hi}</b></span>`;

    // Cascade rétro sur l'en-tête + les trois panneaux + le bas, à l'affichage.
    reveal(this.root, { selector: '.wp-head, .wp-panel, .wp-foot' });
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default WeatherPopup;
