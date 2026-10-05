/**
 * Capital City — Loja do jogador (SPA leve com rotas em hash, pensada para celular e WebView).
 * Fluxo: Loja → Produto → Revisão → Pagamento (PIX) → Confirmação → Entrega no jogo.
 * O navegador nunca define preço nem confirma pagamento: tudo vem da API.
 */
import {
  ApiError,
  api,
  clearBearerToken,
  copyText,
  dateTime,
  durationLabel,
  emptyState,
  errorState,
  h,
  icon,
  img,
  money,
  mount,
  statusBadge,
  toast,
  watchConnection,
} from './lib.js';

const view = document.getElementById('view');

/* --------------------------------------------------------------------------
   Estado global
   -------------------------------------------------------------------------- */
const state = {
  me: null, // { user, gameAccounts }
  meLoaded: false,
  categories: null,
  products: null,
  config: null,
};

let routeController = null; // AbortController da tela atual
let pollTimer = null;

// Modo incorporado (launcher/jogo): ?embed=1 esconde links externos e rodapé.
const params = new URLSearchParams(location.search);
try {
  if (params.get('embed') === '1') sessionStorage.setItem('cc_embed', '1');
  if (sessionStorage.getItem('cc_embed') === '1') document.documentElement.classList.add('cc-embed');
} catch {
  if (params.get('embed') === '1') document.documentElement.classList.add('cc-embed');
}

/* --------------------------------------------------------------------------
   Carrinho (somente IDs e quantidades; preços sempre buscados na API)
   -------------------------------------------------------------------------- */
const CART_KEY = 'cc_cart_v1';
const cart = {
  read() {
    try {
      const data = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  },
  write(items) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
    } catch {
      /* armazenamento indisponível: carrinho dura só nesta tela */
    }
    renderCartCount();
  },
  set(productId, qty) {
    const items = this.read();
    if (qty <= 0) delete items[productId];
    else items[productId] = qty;
    this.write(items);
  },
  add(productId, qty, max) {
    const items = this.read();
    items[productId] = Math.min((items[productId] || 0) + qty, max);
    this.write(items);
  },
  clear() {
    this.write({});
  },
  count() {
    return Object.values(this.read()).reduce((a, b) => a + b, 0);
  },
};

// Itens do checkout atual: { items: [{productId, quantity}], fromCart: bool }
const CHECKOUT_KEY = 'cc_checkout';
const checkout = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(CHECKOUT_KEY) || 'null');
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify(value));
    } catch {
      /* noop */
    }
  },
};

function renderCartCount() {
  const el = document.getElementById('cc-cart-count');
  const n = cart.count();
  el.textContent = String(n);
  el.hidden = n === 0;
}

/* --------------------------------------------------------------------------
   Dados
   -------------------------------------------------------------------------- */
async function loadMe(force = false) {
  if (state.meLoaded && !force) return state.me;
  try {
    const data = await api('/api/me');
    state.me = data.user ? data : null;
  } catch {
    state.me = null;
  }
  state.meLoaded = true;
  renderAccountButton();
  return state.me;
}

async function loadCatalog(signal) {
  if (!state.categories || !state.products) {
    const [c, p] = await Promise.all([api('/api/store/categories', { signal }), api('/api/store/products', { signal })]);
    state.categories = c.categories;
    state.products = p.products;
  }
  return { categories: state.categories, products: state.products };
}

function renderAccountButton() {
  const btn = document.getElementById('cc-account-btn');
  const user = state.me && state.me.user;
  if (user && user.avatarUrl) {
    mount(btn, h('img', { src: user.avatarUrl, alt: '', class: 'cc-avatar', referrerpolicy: 'no-referrer' }));
  } else {
    mount(btn, icon('user', 20));
  }
}

/* --------------------------------------------------------------------------
   Componentes
   -------------------------------------------------------------------------- */
function priceBlock(p, large = false) {
  return h(
    'div',
    { class: `cc-price${large ? ' cc-price-lg' : ''}` },
    p.onSale ? h('s', { class: 'cc-price-old' }, money(p.priceCents)) : null,
    h('strong', null, money(p.finalPriceCents)),
  );
}

function productImage(p, cls) {
  if (p.imageUrl) return h('div', { class: cls }, img(p.imageUrl, p.name));
  return h('div', { class: `${cls} cc-img-placeholder` }, icon(categoryIcon(p.category.id), 34));
}

function categoryIcon(categoryId) {
  const c = (state.categories || []).find((x) => x.id === categoryId);
  return c ? c.icon : 'tag';
}

function productCard(p) {
  return h(
    'a',
    { class: `cc-card${p.available ? '' : ' cc-card-off'}`, href: `#/p/${encodeURIComponent(p.slug)}` },
    productImage(p, 'cc-card-img'),
    p.onSale ? h('span', { class: 'cc-tag cc-tag-sale' }, 'Promoção') : p.isFeatured ? h('span', { class: 'cc-tag' }, 'Destaque') : null,
    h(
      'div',
      { class: 'cc-card-body' },
      h('h3', { class: 'cc-card-title' }, p.name),
      p.shortDescription ? h('p', { class: 'cc-card-desc' }, p.shortDescription) : null,
      h('div', { class: 'cc-card-foot' }, priceBlock(p), p.available ? null : h('span', { class: 'cc-badge cc-badge-muted' }, 'Esgotado')),
    ),
  );
}

function skeletonGrid(n = 6) {
  return h(
    'div',
    { class: 'cc-grid', 'aria-busy': 'true', 'aria-label': 'Carregando produtos' },
    Array.from({ length: n }, () => h('div', { class: 'cc-card cc-skeleton-card' }, h('div', { class: 'cc-card-img cc-skel' }), h('div', { class: 'cc-card-body' }, h('div', { class: 'cc-skel cc-skel-line' }), h('div', { class: 'cc-skel cc-skel-line cc-skel-short' })))),
  );
}

function backLink(href, label) {
  return h('a', { class: 'cc-back', href }, icon('back', 16), label);
}

function stepper(value, min, max, onChange, label = 'Quantidade') {
  const out = h('output', { class: 'cc-stepper-value', 'aria-live': 'polite' }, String(value));
  const set = (v) => {
    const next = Math.max(min, Math.min(max, v));
    out.textContent = String(next);
    dec.disabled = next <= min;
    inc.disabled = next >= max;
    onChange(next);
  };
  const dec = h('button', { type: 'button', class: 'cc-stepper-btn', 'aria-label': 'Diminuir', disabled: value <= min, onclick: () => set(Number(out.textContent) - 1) }, icon('minus', 16));
  const inc = h('button', { type: 'button', class: 'cc-stepper-btn', 'aria-label': 'Aumentar', disabled: value >= max, onclick: () => set(Number(out.textContent) + 1) }, icon('plus', 16));
  return h('div', { class: 'cc-stepper', role: 'group', 'aria-label': label }, dec, out, inc);
}

function maxQty(p) {
  return Math.max(1, Math.min(p.maxPerOrder, p.stockLeft === null ? p.maxPerOrder : p.stockLeft));
}

/* --------------------------------------------------------------------------
   Telas
   -------------------------------------------------------------------------- */
async function homeView(signal, categorySlug) {
  mount(view, h('div', { class: 'cc-container' }, h('div', { class: 'cc-chips cc-skel-chips' }), skeletonGrid()));
  const { categories, products } = await loadCatalog(signal);
  const visible = categorySlug ? products.filter((p) => p.category.slug === categorySlug) : products;
  const current = categories.find((c) => c.slug === categorySlug);
  const featured = !categorySlug ? products.filter((p) => p.isFeatured && p.available).slice(0, 6) : [];

  const chips = h(
    'nav',
    { class: 'cc-chips', 'aria-label': 'Categorias' },
    h('a', { class: `cc-chip${!categorySlug ? ' active' : ''}`, href: '#/', 'aria-current': !categorySlug ? 'page' : null }, 'Tudo'),
    categories
      .filter((c) => c.productCount > 0)
      .map((c) => h('a', { class: `cc-chip${c.slug === categorySlug ? ' active' : ''}`, href: `#/c/${encodeURIComponent(c.slug)}`, 'aria-current': c.slug === categorySlug ? 'page' : null }, icon(c.icon, 15), c.name)),
  );

  let content;
  if (products.length === 0) {
    content = emptyState('bag', 'A loja está sendo preparada', 'Os produtos aparecerão aqui em breve. Fique de olho no Discord!');
  } else if (visible.length === 0) {
    content = emptyState('box', 'Nada por aqui ainda', 'Esta categoria não tem produtos disponíveis no momento.', h('a', { class: 'btn btn-secondary btn-sm', href: '#/' }, 'Ver todos os produtos'));
  } else {
    content = h('div', { class: 'cc-grid' }, visible.map(productCard));
  }

  mount(
    view,
    h(
      'div',
      { class: 'cc-container' },
      h(
        'div',
        { class: 'cc-hero' },
        h('h1', { class: 'cc-title' }, current ? current.name : h('span', null, 'Loja ', h('span', { class: 'text-accent' }, 'Capital City'))),
        h('p', { class: 'cc-sub' }, current && current.description ? current.description : 'Benefícios entregues direto na sua conta do jogo. Pagamento por PIX.'),
      ),
      chips,
      featured.length > 1 ? h('section', { class: 'cc-section' }, h('h2', { class: 'cc-h2' }, 'Destaques'), h('div', { class: 'cc-rail' }, featured.map(productCard))) : null,
      featured.length > 1 ? h('h2', { class: 'cc-h2' }, 'Todos os produtos') : null,
      content,
    ),
  );
}

async function productView(signal, slug) {
  mount(view, h('div', { class: 'cc-container cc-product' }, h('div', { class: 'cc-product-img cc-skel' }), h('div', null, h('div', { class: 'cc-skel cc-skel-line' }), h('div', { class: 'cc-skel cc-skel-line cc-skel-short' }))));
  await loadCatalog(signal).catch(() => null);
  let product;
  try {
    product = (await api(`/api/store/products/${encodeURIComponent(slug)}`, { signal })).product;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      mount(view, h('div', { class: 'cc-container' }, emptyState('box', 'Produto indisponível', 'Este produto não existe ou foi removido da loja.', h('a', { class: 'btn btn-primary btn-sm', href: '#/' }, 'Voltar para a loja'))));
      return;
    }
    throw err;
  }
  let qty = 1;
  const max = maxQty(product);
  const total = h('strong', null, money(product.finalPriceCents));
  const updateTotal = () => {
    total.textContent = money(product.finalPriceCents * qty);
  };

  const buyNow = () => {
    checkout.set({ items: [{ productId: product.id, quantity: qty }], fromCart: false });
    location.hash = '#/revisar';
  };
  const addToCart = () => {
    cart.add(product.id, qty, max);
    toast('Adicionado ao carrinho');
  };

  const facts = [
    ['Duração', durationLabel(product.durationDays)],
    ['Entrega', 'Automática na sua conta do jogo'],
    product.stockLeft !== null ? ['Disponibilidade', product.stockLeft > 0 ? `${product.stockLeft} em estoque` : 'Esgotado'] : ['Disponibilidade', product.available ? 'Disponível' : 'Indisponível'],
  ];

  // Barra de compra: fixa no rodapé no celular (alcance do polegar), logo abaixo do preço no desktop
  const buybar = h(
    'div',
    { class: 'cc-buybar' },
    h('div', { class: 'cc-buybar-total' }, h('span', null, 'Total'), total),
    product.available
      ? [
          h('button', { type: 'button', class: 'btn btn-secondary cc-buybar-cart', 'aria-label': 'Adicionar ao carrinho', onclick: addToCart }, icon('cart', 18)),
          h('button', { type: 'button', class: 'btn btn-primary cc-buybar-cta', onclick: buyNow }, 'Comprar agora'),
        ]
      : h('button', { type: 'button', class: 'btn btn-secondary cc-buybar-cta', disabled: true }, 'Esgotado'),
  );

  mount(
    view,
    h(
      'div',
      { class: 'cc-container' },
      backLink(`#/c/${encodeURIComponent(product.category.slug)}`, product.category.name),
      h(
        'article',
        { class: 'cc-product' },
        productImage(product, 'cc-product-img'),
        h(
          'div',
          { class: 'cc-product-info' },
          h('span', { class: 'cc-eyebrow' }, product.category.name),
          h('h1', { class: 'cc-title' }, product.name),
          product.shortDescription ? h('p', { class: 'cc-sub' }, product.shortDescription) : null,
          h('div', { class: 'cc-product-price' }, priceBlock(product, true), product.onSale && product.promoEndsAt ? h('span', { class: 'cc-muted' }, `Promoção até ${dateTime(product.promoEndsAt)}`) : null),
          product.available && max > 1 ? h('div', { class: 'cc-qty-row' }, h('span', null, 'Quantidade'), stepper(1, 1, max, (v) => { qty = v; updateTotal(); })) : null,
          buybar,
          h('dl', { class: 'cc-facts' }, facts.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v)))),
          product.benefits.length
            ? h('section', { class: 'cc-block' }, h('h2', { class: 'cc-h3' }, 'O que você recebe'), h('ul', { class: 'cc-benefits' }, product.benefits.map((b) => h('li', null, icon('check', 15), b))))
            : null,
          product.description ? h('section', { class: 'cc-block' }, h('h2', { class: 'cc-h3' }, 'Descrição'), h('p', { class: 'cc-text' }, product.description)) : null,
          product.conditions ? h('section', { class: 'cc-block' }, h('h2', { class: 'cc-h3' }, 'Condições'), h('p', { class: 'cc-text cc-muted' }, product.conditions)) : null,
        ),
      ),
    ),
  );
  document.title = `${product.name} — Loja Capital City`;
}

async function cartView(signal) {
  mount(view, h('div', { class: 'cc-container' }, h('h1', { class: 'cc-title' }, 'Carrinho'), skeletonGrid(2)));
  const { products } = await loadCatalog(signal);
  const items = cart.read();
  const lines = Object.entries(items)
    .map(([id, qty]) => ({ product: products.find((p) => p.id === id), qty }))
    .filter((l) => l.product && l.product.available);
  // Remove itens que saíram da loja
  if (lines.length !== Object.keys(items).length) {
    cart.write(Object.fromEntries(lines.map((l) => [l.product.id, Math.min(l.qty, maxQty(l.product))])));
  }

  if (lines.length === 0) {
    mount(view, h('div', { class: 'cc-container' }, h('h1', { class: 'cc-title' }, 'Carrinho'), emptyState('cart', 'Seu carrinho está vazio', 'Escolha um produto na loja para começar.', h('a', { class: 'btn btn-primary btn-sm', href: '#/' }, 'Ver produtos'))));
    return;
  }

  const subtotalEl = h('strong', null);
  const totalEl = h('strong', null);
  const barTotalEl = h('strong', null);
  const recompute = () => {
    const sum = lines.reduce((s, l) => s + l.product.finalPriceCents * l.qty, 0);
    subtotalEl.textContent = money(sum);
    totalEl.textContent = money(sum);
    barTotalEl.textContent = money(sum);
  };
  recompute();

  const list = h(
    'ul',
    { class: 'cc-lines' },
    lines.map((l) => {
      const lineTotal = h('strong', null, money(l.product.finalPriceCents * l.qty));
      const li = h(
        'li',
        { class: 'cc-line' },
        productImage(l.product, 'cc-line-img'),
        h(
          'div',
          { class: 'cc-line-info' },
          h('a', { href: `#/p/${encodeURIComponent(l.product.slug)}`, class: 'cc-line-name' }, l.product.name),
          h('span', { class: 'cc-muted' }, `${money(l.product.finalPriceCents)} cada`),
          h(
            'div',
            { class: 'cc-line-actions' },
            maxQty(l.product) > 1
              ? stepper(l.qty, 1, maxQty(l.product), (v) => {
                  l.qty = v;
                  cart.set(l.product.id, v);
                  lineTotal.textContent = money(l.product.finalPriceCents * v);
                  recompute();
                })
              : h('span', { class: 'cc-muted' }, 'Qtd. 1'),
            h(
              'button',
              {
                type: 'button',
                class: 'cc-icon-btn cc-danger',
                'aria-label': `Remover ${l.product.name}`,
                onclick: () => {
                  cart.set(l.product.id, 0);
                  route();
                },
              },
              icon('trash', 18),
            ),
          ),
        ),
        lineTotal,
      );
      return li;
    }),
  );

  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      backLink('#/', 'Continuar comprando'),
      h('h1', { class: 'cc-title' }, 'Carrinho'),
      list,
      h(
        'div',
        { class: 'cc-summary' },
        h('div', { class: 'cc-summary-row' }, h('span', null, 'Subtotal'), subtotalEl),
        h('div', { class: 'cc-summary-row cc-muted' }, h('span', null, 'Descontos'), h('span', null, money(0))),
        h('div', { class: 'cc-summary-row cc-summary-total' }, h('span', null, 'Total'), totalEl),
        h('p', { class: 'cc-hint' }, 'O valor final é confirmado pelo servidor na revisão do pedido.'),
      ),
      h(
        'div',
        { class: 'cc-buybar' },
        h('div', { class: 'cc-buybar-total' }, h('span', null, 'Total'), barTotalEl),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary cc-buybar-cta',
            onclick: () => {
              checkout.set({ items: lines.map((l) => ({ productId: l.product.id, quantity: l.qty })), fromCart: true });
              location.hash = '#/revisar';
            },
          },
          'Revisar pedido',
        ),
      ),
    ),
  );
}

/** Login com Google (modo redirect: sem popup, funciona melhor em WebView). */
async function loginPanel(returnTo) {
  if (!state.config) state.config = await api('/api/auth/config');
  const cfg = state.config;
  try {
    sessionStorage.setItem('cc_after_login', returnTo);
  } catch {
    /* noop */
  }
  const slot = h('div', { class: 'cc-google-slot' });
  const panel = h(
    'div',
    { class: 'cc-panel cc-login' },
    h('div', { class: 'cc-state-icon' }, icon('user', 26)),
    h('h2', { class: 'cc-h2' }, 'Entre com sua conta Google'),
    h('p', { class: 'cc-sub' }, 'Use a mesma conta Google do jogo. Assim suas compras chegam no personagem certo.'),
    slot,
  );
  if (cfg.googleClientId) {
    const render = () => {
      window.google.accounts.id.initialize({ client_id: cfg.googleClientId, ux_mode: 'redirect', login_uri: cfg.loginUri, auto_select: false });
      window.google.accounts.id.renderButton(slot, { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'signin_with', locale: 'pt-BR', width: 280 });
    };
    if (window.google && window.google.accounts) render();
    else {
      const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true });
      s.addEventListener('load', render);
      s.addEventListener('error', () => mount(slot, h('p', { class: 'cc-error' }, 'Não foi possível carregar o login do Google. Verifique sua conexão.')));
      document.head.append(s);
    }
  } else if (!cfg.devLogin) {
    mount(slot, h('p', { class: 'cc-muted' }, 'Login indisponível no momento.'));
  }
  if (cfg.devLogin) {
    const email = h('input', { class: 'cc-input', type: 'email', placeholder: 'email@exemplo.com', 'aria-label': 'E-mail (desenvolvimento)' });
    panel.append(
      h(
        'form',
        {
          class: 'cc-dev-login',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await api('/api/auth/dev-login', { method: 'POST', body: { email: email.value, name: email.value.split('@')[0] || 'Dev' } });
              await loadMe(true);
              route();
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        h('span', { class: 'cc-muted' }, 'Ambiente de desenvolvimento'),
        email,
        h('button', { class: 'btn btn-secondary btn-sm', type: 'submit' }, 'Entrar (dev)'),
      ),
    );
  }
  return panel;
}

/** Bloco para vincular a conta do jogo: código digitado no jogo com /vincular. */
function linkAccountPanel(onLinked) {
  const box = h('div', { class: 'cc-panel cc-link' });
  const intro = [
    h('h2', { class: 'cc-h3' }, icon('gamepad', 18), ' Vincule sua conta do jogo'),
    h('p', { class: 'cc-text cc-muted' }, 'Se você entra no jogo com esta mesma conta Google, o vínculo é automático depois do seu próximo login no servidor. Se não, gere um código e digite no jogo.'),
  ];
  const gen = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: generate }, icon('link', 14), 'Gerar código de vínculo');
  const check = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: refresh }, icon('refresh', 14), 'Já vinculei');
  mount(box, intro, h('div', { class: 'cc-row' }, gen, check));

  async function generate() {
    gen.disabled = true;
    try {
      const { code, expiresAt } = await api('/api/me/game-accounts/link-code', { method: 'POST' });
      const cmd = `/vincular ${code}`;
      mount(
        box,
        intro,
        h(
          'div',
          { class: 'cc-code' },
          h('span', { class: 'cc-muted' }, 'Digite no chat do jogo:'),
          h('code', null, cmd),
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: async () => toast((await copyText(cmd)) ? 'Comando copiado' : 'Não foi possível copiar', 'ok') }, icon('copy', 14), 'Copiar'),
          h('span', { class: 'cc-hint' }, `Válido até ${dateTime(expiresAt)}.`),
        ),
        h('div', { class: 'cc-row' }, check),
      );
    } catch (err) {
      toast(err.message, 'error');
      gen.disabled = false;
    }
  }
  async function refresh() {
    const me = await loadMe(true);
    if (me && me.gameAccounts.length) onLinked();
    else toast('Ainda não encontramos uma conta vinculada. Confira o comando no jogo.', 'error');
  }
  return box;
}

async function reviewView(signal) {
  const current = checkout.get();
  if (!current || !current.items || !current.items.length) {
    location.replace('#/carrinho');
    return;
  }
  mount(view, h('div', { class: 'cc-container cc-narrow' }, h('h1', { class: 'cc-title' }, 'Revisar pedido'), skeletonGrid(1)));
  const [{ products }, me] = await Promise.all([loadCatalog(signal), loadMe()]);
  const lines = current.items.map((i) => ({ ...i, product: products.find((p) => p.id === i.productId) })).filter((l) => l.product && l.product.available);
  if (!lines.length) {
    mount(view, h('div', { class: 'cc-container cc-narrow' }, emptyState('box', 'Produtos indisponíveis', 'Os itens escolhidos não estão mais disponíveis.', h('a', { class: 'btn btn-primary btn-sm', href: '#/' }, 'Voltar para a loja'))));
    return;
  }
  const estimate = lines.reduce((s, l) => s + l.product.finalPriceCents * l.quantity, 0);

  const summary = h(
    'div',
    { class: 'cc-panel' },
    h('h2', { class: 'cc-h3' }, 'Itens'),
    h('ul', { class: 'cc-review-items' }, lines.map((l) => h('li', null, h('span', null, `${l.quantity}× ${l.product.name}`), h('strong', null, money(l.product.finalPriceCents * l.quantity))))),
    h('div', { class: 'cc-summary-row cc-summary-total' }, h('span', null, 'Total'), h('strong', null, money(estimate))),
  );

  const header = [backLink(current.fromCart ? '#/carrinho' : `#/p/${encodeURIComponent(lines[0].product.slug)}`, 'Voltar'), h('h1', { class: 'cc-title' }, 'Revisar pedido')];

  if (!me) {
    mount(view, h('div', { class: 'cc-container cc-narrow' }, header, summary, await loginPanel('#/revisar')));
    return;
  }
  if (!me.gameAccounts.length) {
    mount(view, h('div', { class: 'cc-container cc-narrow' }, header, summary, linkAccountPanel(() => route())));
    return;
  }

  let accountId = me.gameAccounts[0].id;
  const accounts = h(
    'fieldset',
    { class: 'cc-panel cc-accounts' },
    h('legend', { class: 'cc-h3' }, 'Receber na conta'),
    me.gameAccounts.map((g, i) =>
      h(
        'label',
        { class: 'cc-radio' },
        h('input', { type: 'radio', name: 'account', value: g.id, checked: i === 0, onchange: () => (accountId = g.id) }),
        h('span', { class: 'cc-radio-mark' }),
        h('span', null, h('strong', null, g.nickname), h('small', { class: 'cc-muted' }, ` · ID ${g.serverAccountId}`)),
      ),
    ),
    h('p', { class: 'cc-hint' }, 'O benefício é entregue somente nesta conta. Confira antes de pagar.'),
  );

  // Chave de idempotência: o mesmo checkout nunca gera dois pedidos (clique duplo, conexão instável).
  if (!current.key) {
    current.key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    checkout.set(current);
  }
  const payBtn = h('button', { type: 'button', class: 'btn btn-primary cc-buybar-cta', onclick: pay }, 'Pagar com PIX');
  async function pay() {
    payBtn.disabled = true;
    payBtn.textContent = 'Gerando PIX…';
    try {
      const { order } = await api('/api/store/orders', {
        method: 'POST',
        body: { items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), gameAccountId: accountId, idempotencyKey: `${current.key}-${accountId}` },
      });
      if (order.status === 'pending' && !(order.payment && order.payment.status === 'pending')) {
        await api('/api/payments/create', { method: 'POST', body: { orderId: order.id } });
      }
      if (current.fromCart) cart.clear();
      try {
        sessionStorage.removeItem(CHECKOUT_KEY);
      } catch {
        /* noop */
      }
      location.hash = `#/pedido/${order.id}`;
    } catch (err) {
      toast(err.message, 'error');
      payBtn.disabled = false;
      payBtn.textContent = 'Pagar com PIX';
      if (err.code === 'product_unavailable' || err.code === 'out_of_stock') {
        state.products = null;
      }
    }
  }

  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      header,
      summary,
      accounts,
      h('p', { class: 'cc-hint' }, 'Ao continuar você concorda com as regras do servidor. Benefícios digitais são liberados após a confirmação do pagamento.'),
      h('div', { class: 'cc-buybar' }, h('div', { class: 'cc-buybar-total' }, h('span', null, 'Total'), h('strong', null, money(estimate))), payBtn),
    ),
  );
}

function deliveryInfo(order) {
  const d = order.delivery;
  if (['pending', 'cancelled', 'expired', 'failed'].includes(order.status) || d.status === 'none') return null;
  if (order.status === 'refunded') return { tone: 'muted', icon: 'x', title: 'Pedido reembolsado', text: 'O valor foi devolvido e o benefício foi cancelado.' };
  if (order.status === 'processing') return { tone: 'amber', icon: 'clock', title: 'Pagamento em análise', text: 'Recebemos seu pagamento e a equipe está conferindo. Você não precisa pagar de novo.' };
  if (d.status === 'delivered') return { tone: 'emerald', icon: 'check', title: 'Benefício entregue com sucesso', text: 'Já está disponível na sua conta do jogo.' };
  if (d.status === 'partial') return { tone: 'amber', icon: 'clock', title: 'Entrega em andamento', text: `${d.delivered} de ${d.total} itens entregues. O restante chega quando você estiver online no servidor.` };
  if (d.status === 'failed') return { tone: 'red', icon: 'alert', title: 'Problema na entrega', text: 'Nossa equipe foi avisada e vai resolver. Se precisar, abra um ticket no Discord com o código do pedido.' };
  return { tone: 'amber', icon: 'clock', title: 'Benefício aguardando entrega no jogo', text: 'Entre no servidor com a conta escolhida. A entrega é automática.' };
}

async function orderView(signal, id) {
  mount(view, h('div', { class: 'cc-container cc-narrow' }, h('div', { class: 'cc-skel cc-skel-block' })));
  const me = await loadMe();
  if (!me) {
    mount(view, h('div', { class: 'cc-container cc-narrow' }, await loginPanel(`#/pedido/${id}`)));
    return;
  }
  let order;
  try {
    order = (await api(`/api/store/orders/${encodeURIComponent(id)}`, { signal })).order;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
      mount(view, h('div', { class: 'cc-container cc-narrow' }, emptyState('receipt', 'Pedido não encontrado', null, h('a', { class: 'btn btn-secondary btn-sm', href: '#/pedidos' }, 'Meus pedidos'))));
      return;
    }
    throw err;
  }
  renderOrder(order);

  // Acompanha o pagamento (e depois a entrega) enquanto a tela estiver aberta e visível.
  const waitingPayment = order.status === 'pending';
  const waitingDelivery = ['approved', 'paid'].includes(order.status) && order.delivery.status !== 'delivered';
  if (waitingPayment || waitingDelivery) schedulePoll(id, waitingPayment ? 4000 : 10000, order.status);
}

function schedulePoll(id, delay, lastStatus) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!location.hash.startsWith(`#/pedido/${id}`)) return;
    if (document.hidden) return schedulePoll(id, delay, lastStatus);
    try {
      const { order } = await api(`/api/store/orders/${encodeURIComponent(id)}`);
      if (order.status !== lastStatus && order.status === 'approved') toast('Pagamento confirmado!');
      renderOrder(order);
      const stillPayment = order.status === 'pending';
      const stillDelivery = ['approved', 'paid'].includes(order.status) && order.delivery.status !== 'delivered';
      if (stillPayment || stillDelivery) schedulePoll(id, stillPayment ? 4000 : 10000, order.status);
    } catch {
      schedulePoll(id, Math.min(delay * 2, 30000), lastStatus);
    }
  }, delay);
}

function renderOrder(order) {
  const pending = order.status === 'pending' && order.payment && order.payment.pixCopyPaste;
  const paymentOk = ['paid', 'approved', 'delivered'].includes(order.status);
  const delivery = deliveryInfo(order);

  let paymentBlock;
  if (pending) {
    const remaining = h('span', { class: 'cc-countdown' });
    const tick = () => {
      const ms = new Date(order.expiresAt).getTime() - Date.now();
      if (ms <= 0) {
        remaining.textContent = 'expirado';
        return;
      }
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      remaining.textContent = `${m}:${String(s).padStart(2, '0')}`;
      setTimeout(() => remaining.isConnected && tick(), 1000);
    };
    tick();
    const svg64 = btoa(unescape(encodeURIComponent(order.payment.pixQrSvg)));
    paymentBlock = h(
      'section',
      { class: 'cc-panel cc-pix' },
      h('div', { class: 'cc-status-line' }, h('span', { class: 'cc-dot cc-dot-amber' }), h('strong', null, 'Aguardando pagamento'), h('span', { class: 'cc-muted' }, 'expira em ', remaining)),
      h('p', { class: 'cc-text' }, 'Abra o app do seu banco, escolha PIX e escaneie o QR Code ou use o código copia e cola.'),
      h('div', { class: 'cc-qr' }, h('img', { src: `data:image/svg+xml;base64,${svg64}`, alt: 'QR Code PIX', width: 220, height: 220 })),
      h('div', { class: 'cc-copy' }, h('code', { class: 'cc-copy-code' }, order.payment.pixCopyPaste)),
      h(
        'button',
        { type: 'button', class: 'btn btn-primary cc-full', onclick: async () => toast((await copyText(order.payment.pixCopyPaste)) ? 'Código PIX copiado' : 'Não foi possível copiar', 'ok') },
        icon('copy', 16),
        'Copiar código PIX',
      ),
      h('p', { class: 'cc-hint' }, 'A confirmação é automática em poucos segundos após o pagamento. Não feche o app do banco antes de concluir.'),
      h(
        'div',
        { class: 'cc-row cc-row-between' },
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => route() }, icon('refresh', 14), 'Já paguei'),
        h(
          'button',
          {
            type: 'button',
            class: 'cc-link-btn',
            onclick: async () => {
              if (!confirm('Cancelar este pedido? Se você já pagou, não cancele.')) return;
              try {
                const { order: o } = await api(`/api/store/orders/${order.id}/cancel`, { method: 'POST' });
                renderOrder(o);
                toast('Pedido cancelado');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          'Cancelar pedido',
        ),
      ),
    );
  } else {
    const map = {
      pending: ['amber', 'Aguardando pagamento', 'Não foi possível exibir o PIX. Toque em "Atualizar".'],
      paid: ['emerald', 'Pagamento confirmado', null],
      approved: ['emerald', 'Pagamento confirmado', null],
      delivered: ['emerald', 'Pagamento confirmado', null],
      processing: ['amber', 'Pagamento em análise', null],
      expired: ['muted', 'Pagamento expirado', 'O prazo do PIX terminou. Se ainda quiser o produto, faça um novo pedido.'],
      cancelled: ['muted', 'Pedido cancelado', null],
      failed: ['red', 'Pagamento recusado', 'O pagamento não foi aprovado. Você pode tentar novamente com um novo pedido.'],
      refunded: ['muted', 'Pagamento reembolsado', null],
    };
    const [tone, title, text] = map[order.status] || ['muted', order.status, null];
    paymentBlock = h(
      'section',
      { class: `cc-panel cc-result cc-result-${tone}` },
      h('div', { class: `cc-state-icon cc-state-${tone}` }, icon(paymentOk ? 'check' : tone === 'red' ? 'alert' : 'clock', 26)),
      h('h2', { class: 'cc-h2' }, title),
      order.paidAt ? h('p', { class: 'cc-muted' }, `Pago em ${dateTime(order.paidAt)}`) : null,
      text ? h('p', { class: 'cc-text' }, text) : null,
      ['expired', 'failed', 'cancelled'].includes(order.status) ? h('a', { class: 'btn btn-primary btn-sm', href: '#/' }, 'Voltar para a loja') : null,
      order.status === 'pending' ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => route() }, 'Atualizar') : null,
    );
  }

  const deliveryBlock = delivery
    ? h(
        'section',
        { class: `cc-panel cc-delivery cc-result-${delivery.tone}` },
        h('div', { class: 'cc-status-line' }, h('span', { class: `cc-dot cc-dot-${delivery.tone}` }), h('strong', null, delivery.title)),
        h('p', { class: 'cc-text' }, delivery.text),
        h('p', { class: 'cc-muted' }, 'Conta: ', h('strong', null, order.gameAccount.nickname)),
      )
    : null;

  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      backLink('#/pedidos', 'Meus pedidos'),
      h('div', { class: 'cc-order-head' }, h('h1', { class: 'cc-title' }, 'Pedido ', h('span', { class: 'text-accent' }, order.code)), statusBadge(order.status)),
      paymentBlock,
      deliveryBlock,
      h(
        'section',
        { class: 'cc-panel' },
        h('h2', { class: 'cc-h3' }, 'Resumo'),
        h('ul', { class: 'cc-review-items' }, order.items.map((i) => h('li', null, h('span', null, `${i.quantity}× ${i.name}`), h('strong', null, money(i.totalCents))))),
        order.discountCents ? h('div', { class: 'cc-summary-row' }, h('span', null, 'Descontos'), h('span', null, `- ${money(order.discountCents)}`)) : null,
        h('div', { class: 'cc-summary-row cc-summary-total' }, h('span', null, 'Total'), h('strong', null, money(order.totalCents))),
        h('p', { class: 'cc-muted' }, `Criado em ${dateTime(order.createdAt)} · Conta ${order.gameAccount.nickname}`),
      ),
    ),
  );
}

async function ordersView(signal) {
  mount(view, h('div', { class: 'cc-container cc-narrow' }, h('h1', { class: 'cc-title' }, 'Meus pedidos'), h('div', { class: 'cc-skel cc-skel-block' })));
  const me = await loadMe();
  if (!me) {
    mount(view, h('div', { class: 'cc-container cc-narrow' }, h('h1', { class: 'cc-title' }, 'Meus pedidos'), await loginPanel('#/pedidos')));
    return;
  }
  const list = h('ul', { class: 'cc-orders' });
  const more = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', hidden: true }, 'Carregar mais');
  let page = 1;
  const load = async () => {
    more.disabled = true;
    const data = await api(`/api/store/orders?page=${page}`, { signal });
    for (const o of data.orders) {
      const d = deliveryInfo(o);
      list.append(
        h(
          'li',
          null,
          h(
            'a',
            { class: 'cc-order-row', href: `#/pedido/${o.id}` },
            h('div', null, h('strong', null, o.code), h('span', { class: 'cc-muted' }, `${dateTime(o.createdAt)} · ${o.items.map((i) => i.name).join(', ')}`)),
            h('div', { class: 'cc-order-row-end' }, h('strong', null, money(o.totalCents)), statusBadge(o.status), d && d.tone === 'amber' && o.status !== 'processing' ? h('small', { class: 'text-amber' }, 'Aguardando entrega') : null),
            icon('chevron', 16, 'cc-chevron'),
          ),
        ),
      );
    }
    more.hidden = !data.hasMore;
    more.disabled = false;
    page++;
    return data.orders.length;
  };
  more.addEventListener('click', () => load().catch((err) => toast(err.message, 'error')));
  const count = await load();
  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      h('h1', { class: 'cc-title' }, 'Meus pedidos'),
      count === 0 ? emptyState('receipt', 'Você ainda não fez pedidos', null, h('a', { class: 'btn btn-primary btn-sm', href: '#/' }, 'Ir para a loja')) : [list, more],
    ),
  );
}

async function accountView() {
  mount(view, h('div', { class: 'cc-container cc-narrow' }, h('h1', { class: 'cc-title' }, 'Minha conta'), h('div', { class: 'cc-skel cc-skel-block' })));
  const me = await loadMe(true);
  if (!me) {
    mount(view, h('div', { class: 'cc-container cc-narrow' }, h('h1', { class: 'cc-title' }, 'Minha conta'), await loginPanel('#/conta')));
    return;
  }
  // Volta para onde o jogador estava antes do login (ex.: revisão do pedido)
  try {
    const after = sessionStorage.getItem('cc_after_login');
    if (after && after !== '#/conta') {
      sessionStorage.removeItem('cc_after_login');
      location.replace(after);
      return;
    }
    sessionStorage.removeItem('cc_after_login');
  } catch {
    /* noop */
  }

  const accounts = me.gameAccounts.length
    ? h(
        'ul',
        { class: 'cc-accounts-list' },
        me.gameAccounts.map((g) =>
          h(
            'li',
            null,
            icon('gamepad', 18),
            h('span', null, h('strong', null, g.nickname), h('small', { class: 'cc-muted' }, ` · ID ${g.serverAccountId}`)),
            h(
              'button',
              {
                type: 'button',
                class: 'cc-link-btn',
                onclick: async () => {
                  if (!confirm(`Desvincular ${g.nickname}?`)) return;
                  try {
                    await api(`/api/me/game-accounts/${g.id}`, { method: 'DELETE' });
                    route();
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                },
              },
              'Desvincular',
            ),
          ),
        ),
      )
    : null;

  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      h('h1', { class: 'cc-title' }, 'Minha conta'),
      h(
        'section',
        { class: 'cc-panel cc-profile' },
        me.user.avatarUrl ? h('img', { src: me.user.avatarUrl, alt: '', class: 'cc-avatar-lg', referrerpolicy: 'no-referrer' }) : h('div', { class: 'cc-avatar-lg cc-img-placeholder' }, icon('user', 24)),
        h('div', null, h('strong', null, me.user.name || 'Jogador'), h('span', { class: 'cc-muted' }, me.user.email || '')),
      ),
      h('section', { class: 'cc-panel' }, h('h2', { class: 'cc-h3' }, 'Contas do jogo'), accounts || h('p', { class: 'cc-muted' }, 'Nenhuma conta vinculada ainda.')),
      linkAccountPanel(() => route()),
      h(
        'div',
        { class: 'cc-row' },
        h('a', { class: 'btn btn-secondary btn-sm', href: '#/pedidos' }, icon('receipt', 14), 'Meus pedidos'),
        me.user.role === 'admin' ? h('a', { class: 'btn btn-secondary btn-sm', href: '../admin/' }, 'Painel admin') : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary btn-sm',
            onclick: async () => {
              await api('/api/auth/logout', { method: 'POST' }).catch(() => null);
              clearBearerToken();
              state.me = null;
              renderAccountButton();
              location.hash = '#/';
            },
          },
          icon('logout', 14),
          'Sair',
        ),
      ),
    ),
  );
}

/* --------------------------------------------------------------------------
   Roteador
   -------------------------------------------------------------------------- */
const routes = [
  [/^#?\/?$/, (s) => homeView(s)],
  [/^#\/c\/([^/]+)$/, (s, m) => homeView(s, decodeURIComponent(m[1]))],
  [/^#\/p\/([^/]+)$/, (s, m) => productView(s, decodeURIComponent(m[1]))],
  [/^#\/carrinho$/, (s) => cartView(s)],
  [/^#\/revisar$/, (s) => reviewView(s)],
  [/^#\/pedido\/([0-9a-f-]{36})$/i, (s, m) => orderView(s, m[1])],
  [/^#\/pedidos$/, (s) => ordersView(s)],
  [/^#\/conta$/, () => accountView()],
];

async function route() {
  if (routeController) routeController.abort();
  clearTimeout(pollTimer);
  routeController = new AbortController();
  const signal = routeController.signal;
  const hash = location.hash || '#/';
  document.title = 'Loja — Capital City Roleplay';
  const match = routes.map(([re, fn]) => [hash.match(re), fn]).find(([m]) => m);
  const [m, fn] = match || [null, () => homeView(signal)];
  try {
    await fn(signal, m);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    mount(view, h('div', { class: 'cc-container' }, errorState(err, () => route())));
  }
  if (!signal.aborted) window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', () => {
  mount(document.getElementById('cc-cart-icon'), icon('cart', 20));
  renderAccountButton();
  renderCartCount();
  watchConnection();
  loadMe();
  route();
});
