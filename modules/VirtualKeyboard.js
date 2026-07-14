/**
 * Virtual Keyboard
 * Clavier à l'écran piloté au CURSEUR (clics) de la télécommande. Gros pavés
 * (TV basse résolution). Comme la saisie se fait au clic et non par de vrais
 * évènements clavier, il n'entre pas en conflit avec le KeyboardHandler global.
 *
 * Émet :
 *   'submit' (texte)   quand l'utilisateur valide la recherche
 *   'close'            quand il ferme le clavier
 */

import { EventEmitter } from './EventEmitter.js';
import { footerHtml, wireFooterNav } from './CrtFooter.js';

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm'],
  ['w', 'x', 'c', 'v', 'b', 'n'],
];

export class VirtualKeyboard extends EventEmitter {
  constructor() {
    super();
    this.root = null;
    this.input = '';
    this.isOpen = false;
  }

  init() {
    const root = document.createElement('div');
    root.id = 'virtual-keyboard';

    const keysHtml = ROWS.map(
      (row) =>
        `<div class="vk-row">${row
          .map((k) => `<button class="vk-key" data-key="${k}" type="button">${k}</button>`)
          .join('')}</div>`
    ).join('');

    root.innerHTML = `
      <div class="crt-header">
        <span class="crt-title">Search</span>
        <span class="crt-clock-wrap"><span class="crt-clock"></span><span class="crt-date"></span></span>
      </div>
      <div class="vk-panel">
        <div class="vk-prompt">Search for:</div>
        <div class="vk-display"><span class="vk-text"></span><span class="vk-caret">|</span></div>
        <div class="vk-keys">${keysHtml}</div>
        <div class="vk-row vk-actions">
          <button class="vk-key vk-space" data-action="space" type="button">Space</button>
          <button class="vk-key vk-back" data-action="back" type="button">&larr; Back</button>
          <button class="vk-key vk-clear" data-action="clear" type="button">Clear</button>
          <button class="vk-key vk-submit" data-action="submit" type="button">Search</button>
        </div>
      </div>
      ${footerHtml('<button class="crt-navbtn vk-cancel" data-action="cancel" type="button">[Cancel]</button>')}
    `;
    document.body.appendChild(root);
    this.root = root;
    this.textEl = root.querySelector('.vk-text');

    wireFooterNav(root, this);
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.dataset.nav) return; // les raccourcis sont gérés par wireFooterNav
      if (btn.dataset.key) this.type(btn.dataset.key);
      else if (btn.dataset.action) this.action(btn.dataset.action);
    });

    return this;
  }

  open(initial = '') {
    this.input = initial;
    this.render();
    this.isOpen = true;
    this.root.classList.add('open');
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
  }

  type(ch) {
    this.input += ch;
    this.render();
  }

  action(name) {
    switch (name) {
      case 'space':
        this.input += ' ';
        break;
      case 'back':
        this.input = this.input.slice(0, -1);
        break;
      case 'clear':
        this.input = '';
        break;
      case 'cancel':
        this.close();
        this.emit('close');
        return;
      case 'submit':
        if (this.input.trim()) {
          this.emit('submit', this.input.trim());
        }
        return;
    }
    this.render();
  }

  render() {
    this.textEl.textContent = this.input;
  }
}

export default VirtualKeyboard;
