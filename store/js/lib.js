/**
 * Capital City — utilitários compartilhados pela loja e pelo painel.
 * Sem dependências externas. Todo conteúdo dinâmico é inserido via textContent (proteção contra XSS).
 */

/* --------------------------------------------------------------------------
   Sessão do launcher: o app pode abrir a loja com #token=... (token de sessão
   obtido em POST /api/auth/google com mode=token). O token fica só na aba.
   -------------------------------------------------------------------------- */
const TOKEN_KEY = 'cc_token';

function readLauncherToken() {
  const match = location.hash.match(/(?:^#|&)token=([A-Za-z0-9_-]{20,200})/);
  if (match) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      /* armazenamento indisponível */
    }
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
}
readLauncherToken();

function bearerToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function clearBearerToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

/* --------------------------------------------------------------------------
   API
   -------------------------------------------------------------------------- */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Chamada à API com tratamento de erro padronizado. Lança ApiError (status 0 = sem conexão). */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  const token = bearerToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (method !== 'GET' && method !== 'DELETE') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', 'Sem conexão. Verifique sua internet e tente novamente.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = data && data.error ? data.error : {};
    throw new ApiError(res.status, e.code || 'error', e.message || 'Algo deu errado. Tente novamente.', e.details);
  }
  return data;
}

/* --------------------------------------------------------------------------
   DOM
   -------------------------------------------------------------------------- */
/**
 * Cria elementos: h('div', { class: 'x', onclick: fn }, 'texto', filho).
 * Strings viram nós de texto (nunca HTML). Atributos null/false são ignorados.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'value') el.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
}

/* --------------------------------------------------------------------------
   Ícones (SVG constantes, estilo de traço igual ao site)
   -------------------------------------------------------------------------- */
const ICONS = {
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  bag: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  gamepad: '<line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="15" y1="13" x2="15.01" y2="13"/><line x1="18" y1="11" x2="18.01" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  // Ícones de categoria
  crown: '<path d="M2 18h20l-2-11-5 5-3-7-3 7-5-5z"/><line x1="4" y1="21" x2="20" y2="21"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="M16.71 13.88l.7.71-2.82 2.82"/>',
  car: '<path d="M5 17h14v-5l-2-5H7l-2 5z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/><line x1="5" y1="12" x2="19" y2="12"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.75 1.5-1.5 0-.42-.16-.8-.43-1.07-.26-.27-.42-.65-.42-1.07 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-4.96-4.49-9-10-9z"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
};

export function icon(name, size = 18, extraClass = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (extraClass) svg.setAttribute('class', extraClass);
  // Conteúdo constante definido acima (nunca dado do usuário).
  svg.innerHTML = ICONS[name] || ICONS.tag;
  return svg;
}

/* --------------------------------------------------------------------------
   Formatação
   -------------------------------------------------------------------------- */
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents) => brl.format((Number(cents) || 0) / 100);

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const dateTime = (value) => (value ? dateFmt.format(new Date(value)) : '—');

export function durationLabel(days) {
  if (!days) return 'Permanente';
  if (days % 30 === 0) return days === 30 ? '30 dias (1 mês)' : `${days} dias (${days / 30} meses)`;
  return days === 1 ? '1 dia' : `${days} dias`;
}

export const ORDER_STATUS = {
  pending: { label: 'Aguardando pagamento', tone: 'amber' },
  processing: { label: 'Pagamento em análise', tone: 'amber' },
  paid: { label: 'Pagamento confirmado', tone: 'emerald' },
  approved: { label: 'Pagamento confirmado', tone: 'emerald' },
  delivered: { label: 'Entregue', tone: 'emerald' },
  cancelled: { label: 'Cancelado', tone: 'muted' },
  expired: { label: 'Expirado', tone: 'muted' },
  failed: { label: 'Pagamento recusado', tone: 'red' },
  refunded: { label: 'Reembolsado', tone: 'muted' },
};

export function statusBadge(status, map = ORDER_STATUS) {
  const s = map[status] || { label: status, tone: 'muted' };
  return h('span', { class: `cc-badge cc-badge-${s.tone}` }, s.label);
}

/* --------------------------------------------------------------------------
   Feedback
   -------------------------------------------------------------------------- */
export function toast(message, tone = 'ok') {
  let box = document.getElementById('cc-toasts');
  if (!box) {
    box = h('div', { id: 'cc-toasts', class: 'cc-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const el = h('div', { class: `cc-toast cc-toast-${tone}` }, icon(tone === 'error' ? 'alert' : 'check', 16), h('span', null, message));
  box.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback para WebViews sem Clipboard API
    const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Estado de erro reutilizável com botão de tentar novamente. */
export function errorState(err, onRetry) {
  const offline = err && err.status === 0;
  return h(
    'div',
    { class: 'cc-state' },
    h('div', { class: 'cc-state-icon cc-state-error' }, icon(offline ? 'wifiOff' : 'alert', 26)),
    h('h3', null, offline ? 'Sem conexão' : 'Não foi possível carregar'),
    h('p', null, err && err.message ? err.message : 'Tente novamente em instantes.'),
    onRetry ? h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onclick: onRetry }, icon('refresh', 14), 'Tentar novamente') : null,
  );
}

export function emptyState(iconName, title, text, action) {
  return h(
    'div',
    { class: 'cc-state' },
    h('div', { class: 'cc-state-icon' }, icon(iconName, 26)),
    h('h3', null, title),
    text ? h('p', null, text) : null,
    action || null,
  );
}

/** Imagem com fade-in (compatível com a regra img[loading=lazy] do style.css). */
export function img(src, alt, attrs = {}) {
  const el = h('img', { src, alt, loading: 'lazy', decoding: 'async', ...attrs });
  const done = () => el.classList.add('is-loaded');
  el.addEventListener('load', done, { once: true });
  el.addEventListener('error', done, { once: true });
  return el;
}

/** Banner de conexão perdida, compartilhado por loja e painel. */
export function watchConnection() {
  const bar = h('div', { class: 'cc-offline', role: 'alert', hidden: true }, icon('wifiOff', 16), 'Conexão perdida. Tentando reconectar…');
  document.body.append(bar);
  const update = () => {
    bar.hidden = navigator.onLine;
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}
