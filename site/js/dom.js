// DOM-Helfer. Elemente entstehen nur über createElement und Textknoten – nie über innerHTML,
// denn Token-Namen kommen aus der Chain und können beliebigen Text enthalten.

const BOOLEAN_PROPS = new Set(['checked', 'disabled', 'hidden', 'value']);
const SVG_NS = 'http://www.w3.org/2000/svg';

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Baut ein Element. props: class (Text oder Liste), text, on ({ click: fn }), dataset,
 * checked/disabled/hidden/value als Eigenschaften, alles andere als Attribut.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'on') for (const [type, handler] of Object.entries(value)) el.addEventListener(type, handler);
    else if (key === 'dataset') for (const [name, data] of Object.entries(value)) el.dataset[name] = String(data);
    else if (BOOLEAN_PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(el, children);
  return el;
}

/** Phosphor-Icon. Ohne label nur Dekoration (aria-hidden). */
export function icon(name, { fill = false, label, cls } = {}) {
  return h('i', {
    class: [fill ? 'ph-fill' : 'ph-bold', `ph-${name}`, cls],
    'aria-hidden': label ? undefined : 'true',
    role: label ? 'img' : undefined,
    'aria-label': label,
  });
}

/** Solana-Zeichen aus dem Sprite in index.html (Symbol #sol-mark). */
export function solMark(cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', ['app-sol', cls].filter(Boolean).join(' '));
  svg.setAttribute('viewBox', '0 0 100 80');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#sol-mark');
  svg.append(use);
  return svg;
}

export function setContent(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
}

// Puppertinos modals.js legt den Manager als globale Konstante an.
function modalManager() {
  // eslint-disable-next-line no-undef
  return typeof PuppertinoModalManager === 'undefined' ? null : PuppertinoModalManager;
}

export function openModal(id) {
  modalManager()?.openModal(`#${id}`);
}

export function closeModal(id) {
  modalManager()?.closeModal(`#${id}`);
}

export function isModalOpen(id) {
  return document.getElementById(id)?.classList.contains('active') ?? false;
}

/** Ruft callback auf, sobald das Modal geschlossen wird (egal wie). */
export function onModalClose(id, callback) {
  const el = document.getElementById(id);
  if (!el) return () => {};
  const observer = new MutationObserver(() => {
    if (el.getAttribute('aria-hidden') === 'true') callback();
  });
  observer.observe(el, { attributes: true, attributeFilter: ['aria-hidden'] });
  return () => observer.disconnect();
}

export function showError(title, message) {
  setContent(document.getElementById('error-alert-title'), title);
  setContent(document.getElementById('error-alert-text'), message);
  openModal('error-alert');
}
