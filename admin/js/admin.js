/**
 * Capital City — Painel administrativo de vendas.
 * Toda regra de negócio e autorização fica no backend; esta tela só consome /api/admin/*.
 */
import { ApiError, api, dateTime, durationLabel, emptyState, errorState, h, icon, img, money, mount, statusBadge, toast, watchConnection } from '../../store/js/lib.js';

const view = document.getElementById('view');
let meta = null;
let routeController = null;

const DELIVERY_STATUS = {
  pending: { label: 'Na fila', tone: 'amber' },
  processing: { label: 'Processando', tone: 'blue' },
  delivered: { label: 'Entregue', tone: 'emerald' },
  failed: { label: 'Falhou', tone: 'red' },
  cancelled: { label: 'Cancelada', tone: 'muted' },
};
const PAYMENT_STATUS = {
  pending: { label: 'Pendente', tone: 'amber' },
  paid: { label: 'Pago', tone: 'emerald' },
  failed: { label: 'Falhou', tone: 'red' },
  expired: { label: 'Expirado', tone: 'muted' },
  cancelled: { label: 'Cancelado', tone: 'muted' },
  refunded: { label: 'Reembolsado', tone: 'muted' },
};
const ADMIN_ORDER_STATUS = {
  pending: { label: 'Pendente', tone: 'amber' },
  processing: { label: 'Em análise', tone: 'amber' },
  paid: { label: 'Pago', tone: 'emerald' },
  approved: { label: 'Aprovado', tone: 'blue' },
  delivered: { label: 'Entregue', tone: 'emerald' },
  cancelled: { label: 'Cancelado', tone: 'muted' },
  expired: { label: 'Expirado', tone: 'muted' },
  refunded: { label: 'Reembolsado', tone: 'muted' },
  failed: { label: 'Falhou', tone: 'red' },
};
const SOURCE_LABEL = { system: 'Sistema', player: 'Jogador', webhook: 'Webhook', reconcile: 'Consulta ao gateway', admin: 'Admin', game: 'Servidor do jogo' };

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */
const centsToInput = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ','));

function inputToCents(value) {
  const clean = String(value).trim().replace(/\s|R\$/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (clean === '') return null;
  const n = Number(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function field(label, control, hint) {
  return h('label', { class: 'ad-field' }, h('span', { class: 'ad-label' }, label), control, hint ? h('small', { class: 'cc-muted' }, hint) : null);
}

function pageHead(title, ...actions) {
  return h('div', { class: 'ad-head' }, h('h1', { class: 'cc-title' }, title), actions.length ? h('div', { class: 'ad-head-actions' }, actions) : null);
}

/** Diálogo de confirmação com motivo obrigatório (registrado na auditoria). */
function askReason(title, description, confirmLabel, danger = false) {
  return new Promise((resolve) => {
    const textarea = h('textarea', { class: 'cc-textarea', required: true, minlength: 3, maxlength: 300, placeholder: 'Motivo (fica registrado na auditoria)' });
    const dialog = h(
      'dialog',
      { class: 'ad-dialog' },
      h(
        'form',
        { method: 'dialog', class: 'ad-dialog-body' },
        h('h2', { class: 'cc-h3' }, title),
        description ? h('p', { class: 'cc-text' }, description) : null,
        textarea,
        h(
          'div',
          { class: 'cc-row cc-row-between' },
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => dialog.close('') }, 'Voltar'),
          h('button', { type: 'submit', class: `btn btn-sm ${danger ? 'ad-btn-danger' : 'btn-primary'}`, value: 'ok' }, confirmLabel),
        ),
      ),
    );
    dialog.addEventListener('close', () => {
      const ok = dialog.returnValue === 'ok' && textarea.value.trim().length >= 3;
      dialog.remove();
      resolve(ok ? textarea.value.trim() : null);
    });
    document.body.append(dialog);
    dialog.showModal();
    textarea.focus();
  });
}

function confirmDialog(title, text, label = 'Confirmar', danger = false) {
  return new Promise((resolve) => {
    const dialog = h(
      'dialog',
      { class: 'ad-dialog' },
      h(
        'form',
        { method: 'dialog', class: 'ad-dialog-body' },
        h('h2', { class: 'cc-h3' }, title),
        h('p', { class: 'cc-text' }, text),
        h(
          'div',
          { class: 'cc-row cc-row-between' },
          h('button', { type: 'submit', class: 'btn btn-secondary btn-sm', value: '' }, 'Voltar'),
          h('button', { type: 'submit', class: `btn btn-sm ${danger ? 'ad-btn-danger' : 'btn-primary'}`, value: 'ok' }, label),
        ),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'ok');
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function action(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message || 'Erro', 'error');
    return null;
  }
}

function tableOrCards(columns, rows, onRow) {
  // Tabela no desktop; no celular cada linha vira um cartão (CSS).
  return h(
    'div',
    { class: 'ad-table-wrap' },
    h(
      'table',
      { class: 'ad-table' },
      h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.class || null }, c.label)))),
      h(
        'tbody',
        null,
        rows.map((r) =>
          h(
            'tr',
            { class: onRow ? 'ad-clickable' : null, tabindex: onRow ? 0 : null, onclick: onRow ? () => onRow(r) : null, onkeydown: onRow ? (e) => e.key === 'Enter' && onRow(r) : null },
            columns.map((c) => h('td', { 'data-label': c.label, class: c.class || null }, c.render(r))),
          ),
        ),
      ),
    ),
  );
}

/* --------------------------------------------------------------------------
   Dashboard
   -------------------------------------------------------------------------- */
async function dashboardView(signal) {
  mount(view, h('div', { class: 'cc-container' }, pageHead('Visão geral'), h('div', { class: 'ad-kpis' }, Array.from({ length: 6 }, () => h('div', { class: 'ad-kpi cc-skel' })))));
  let days = Number(sessionStorage.getItem('ad_days') || 30);
  const render = async () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const d = await api(`/api/admin/dashboard?from=${from.toISOString()}&to=${to.toISOString()}`, { signal });
    const kpi = (label, value, sub, tone) => h('div', { class: `ad-kpi${tone ? ` ad-kpi-${tone}` : ''}` }, h('span', { class: 'ad-kpi-label' }, label), h('strong', { class: 'ad-kpi-value' }, value), sub ? h('span', { class: 'cc-muted' }, sub) : null);
    const maxQty = Math.max(1, ...d.topProducts.map((p) => p.quantity));
    const periodSelect = h(
      'div',
      { class: 'ad-segment', role: 'group', 'aria-label': 'Período' },
      [7, 30, 90].map((n) =>
        h(
          'button',
          {
            type: 'button',
            class: n === days ? 'active' : null,
            'aria-pressed': n === days ? 'true' : 'false',
            onclick: () => {
              days = n;
              sessionStorage.setItem('ad_days', String(n));
              render().catch((err) => toast(err.message, 'error'));
            },
          },
          `${n} dias`,
        ),
      ),
    );
    mount(
      view,
      h(
        'div',
        { class: 'cc-container' },
        pageHead('Visão geral', periodSelect),
        h(
          'div',
          { class: 'ad-kpis' },
          kpi('Receita total', money(d.revenue.total), 'Desde o início'),
          kpi(`Receita (${days} dias)`, money(d.revenue.period), `${d.sales.period} vendas`),
          kpi('Vendas hoje', String(d.sales.today), money(d.revenue.today)),
          kpi('Nesta semana', String(d.sales.week), money(d.revenue.week)),
          kpi('Neste mês', String(d.sales.month), money(d.revenue.month)),
          kpi(`Ticket médio (${days} dias)`, money(d.averageTicketCents)),
        ),
        h(
          'div',
          { class: 'ad-pills' },
          h('a', { href: '#/pedidos?status=pending', class: 'ad-pill' }, h('strong', null, d.orders.pending), ' pendentes'),
          d.orders.review ? h('a', { href: '#/pedidos?status=processing', class: 'ad-pill ad-pill-warn' }, h('strong', null, d.orders.review), ' em análise') : null,
          h('a', { href: '#/pedidos?status=approved', class: 'ad-pill' }, h('strong', null, d.orders.approved), ' aprovados'),
          h('a', { href: '#/pedidos?status=cancelled', class: 'ad-pill' }, h('strong', null, d.orders.cancelled), ' cancelados/expirados'),
          d.orders.refunded ? h('a', { href: '#/pedidos?status=refunded', class: 'ad-pill' }, h('strong', null, d.orders.refunded), ' reembolsados') : null,
          h('span', { class: `ad-pill${d.deliveries.failed ? ' ad-pill-danger' : ''}` }, h('strong', null, d.deliveries.pending), ' entregas na fila', d.deliveries.failed ? ` · ${d.deliveries.failed} com falha` : ''),
        ),
        h(
          'div',
          { class: 'ad-two' },
          h(
            'section',
            { class: 'cc-panel' },
            h('h2', { class: 'cc-h3' }, `Mais vendidos (${days} dias)`),
            d.topProducts.length
              ? h(
                  'ol',
                  { class: 'ad-rank' },
                  d.topProducts.map((p) =>
                    h(
                      'li',
                      null,
                      h('div', { class: 'ad-rank-row' }, h('span', null, p.name), h('strong', null, `${p.quantity} un.`)),
                      h('div', { class: 'ad-bar' }, h('span', { style: `width:${Math.round((p.quantity / maxQty) * 100)}%` })),
                      h('small', { class: 'cc-muted' }, money(p.revenueCents)),
                    ),
                  ),
                )
              : h('p', { class: 'cc-muted' }, 'Nenhuma venda no período.'),
          ),
          h(
            'section',
            { class: 'cc-panel' },
            h('div', { class: 'ad-panel-head' }, h('h2', { class: 'cc-h3' }, 'Últimas vendas'), h('a', { href: '#/pedidos', class: 'cc-link-btn' }, 'Ver todas')),
            d.recentSales.length
              ? h(
                  'ul',
                  { class: 'ad-list' },
                  d.recentSales.map((o) =>
                    h(
                      'li',
                      null,
                      h(
                        'a',
                        { href: `#/pedido/${o.id}`, class: 'ad-list-row' },
                        h('div', null, h('strong', null, o.nickname), h('small', { class: 'cc-muted' }, `${o.code} · ${dateTime(o.paidAt)}`)),
                        h('div', { class: 'ad-list-end' }, h('strong', null, money(o.totalCents)), statusBadge(o.status, ADMIN_ORDER_STATUS)),
                      ),
                    ),
                  ),
                )
              : h('p', { class: 'cc-muted' }, 'Ainda não há vendas.'),
          ),
        ),
      ),
    );
  };
  await render();
}

/* --------------------------------------------------------------------------
   Vendas
   -------------------------------------------------------------------------- */
async function ordersView(signal, query) {
  const q = new URLSearchParams(query);
  const page = Number(q.get('page') || 1);
  mount(view, h('div', { class: 'cc-container' }, pageHead('Vendas'), h('div', { class: 'cc-skel cc-skel-block' })));
  const [data, products] = await Promise.all([api(`/api/admin/orders?${q.toString()}`, { signal }), api('/api/admin/products', { signal })]);

  const search = h('input', { class: 'cc-input', type: 'search', name: 'q', value: q.get('q') || '', placeholder: 'Código, jogador, e-mail ou ID da transação' });
  const status = h('select', { class: 'cc-select', name: 'status' }, h('option', { value: '' }, 'Todos os status'), meta.orderStatuses.map((s) => h('option', { value: s, selected: q.get('status') === s }, (ADMIN_ORDER_STATUS[s] || { label: s }).label)));
  const product = h('select', { class: 'cc-select', name: 'productId' }, h('option', { value: '' }, 'Todos os produtos'), products.products.map((p) => h('option', { value: p.id, selected: q.get('productId') === p.id }, p.name)));
  const from = h('input', { class: 'cc-input', type: 'date', name: 'from', value: (q.get('from') || '').slice(0, 10) });
  const to = h('input', { class: 'cc-input', type: 'date', name: 'to', value: (q.get('to') || '').slice(0, 10) });

  const apply = (e) => {
    e.preventDefault();
    const next = new URLSearchParams();
    if (search.value.trim()) next.set('q', search.value.trim());
    if (status.value) next.set('status', status.value);
    if (product.value) next.set('productId', product.value);
    if (from.value) next.set('from', new Date(`${from.value}T00:00:00`).toISOString());
    if (to.value) next.set('to', new Date(`${to.value}T23:59:59`).toISOString());
    location.hash = `#/pedidos?${next.toString()}`;
  };

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const goPage = (n) => {
    q.set('page', String(n));
    location.hash = `#/pedidos?${q.toString()}`;
  };

  mount(
    view,
    h(
      'div',
      { class: 'cc-container' },
      pageHead('Vendas', h('span', { class: 'cc-muted' }, `${data.total} pedido(s)`)),
      h(
        'form',
        { class: 'ad-filters', onsubmit: apply },
        h('div', { class: 'ad-filter-search' }, search),
        status,
        product,
        h('div', { class: 'ad-dates' }, from, h('span', { class: 'cc-muted' }, 'até'), to),
        h('div', { class: 'ad-filter-actions' }, h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, icon('search', 14), 'Filtrar'), h('a', { class: 'btn btn-secondary btn-sm', href: '#/pedidos' }, 'Limpar')),
      ),
      data.orders.length
        ? tableOrCards(
            [
              { label: 'Pedido', render: (o) => h('div', null, h('strong', null, o.code), h('small', { class: 'cc-muted ad-block' }, dateTime(o.createdAt))) },
              { label: 'Jogador', render: (o) => h('div', null, h('strong', null, o.nickname), h('small', { class: 'cc-muted ad-block' }, o.user.email || o.user.name)) },
              { label: 'Itens', class: 'ad-col-items', render: (o) => o.itemsLabel },
              { label: 'Total', class: 'ad-num', render: (o) => h('strong', null, money(o.totalCents)) },
              { label: 'Status', render: (o) => statusBadge(o.status, ADMIN_ORDER_STATUS) },
            ],
            data.orders,
            (o) => (location.hash = `#/pedido/${o.id}`),
          )
        : emptyState('receipt', 'Nenhum pedido encontrado', 'Ajuste os filtros para ver outros pedidos.'),
      totalPages > 1
        ? h(
            'div',
            { class: 'ad-pager' },
            h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: page <= 1, onclick: () => goPage(page - 1) }, icon('back', 14), 'Anterior'),
            h('span', { class: 'cc-muted' }, `Página ${page} de ${totalPages}`),
            h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: page >= totalPages, onclick: () => goPage(page + 1) }, 'Próxima', icon('chevron', 14)),
          )
        : null,
    ),
  );
}

async function orderDetailView(signal, id) {
  mount(view, h('div', { class: 'cc-container' }, h('div', { class: 'cc-skel cc-skel-block' })));
  const { order } = await api(`/api/admin/orders/${id}`, { signal });
  renderOrderDetail(order);
}

function renderOrderDetail(o) {
  const run = async (path, body, success) => {
    const res = await action(() => api(path, { method: 'POST', body }), success);
    if (res && res.order) renderOrderDetail(res.order);
  };

  const actions = [
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => run(`/api/admin/orders/${o.id}/recheck`, {}, 'Gateway consultado') }, icon('refresh', 14), 'Consultar gateway'),
  ];
  if (o.status === 'pending') {
    actions.push(
      h('button', {
        type: 'button',
        class: 'btn btn-secondary btn-sm',
        onclick: async () => {
          const reason = await askReason('Cancelar pedido', 'O PIX deixa de valer e o estoque é devolvido.', 'Cancelar pedido', true);
          if (reason) run(`/api/admin/orders/${o.id}/cancel`, { reason }, 'Pedido cancelado');
        },
      }, 'Cancelar'),
    );
  }
  if (o.status === 'processing') {
    actions.push(
      h('button', {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: async () => {
          const reason = await askReason('Aprovar pedido em análise', 'Confirme que o pagamento foi conferido no painel do gateway. As entregas serão criadas.', 'Aprovar e liberar');
          if (reason) run(`/api/admin/orders/${o.id}/approve`, { reason }, 'Pedido aprovado');
        },
      }, 'Aprovar'),
    );
  }
  if (['paid', 'approved', 'delivered', 'processing'].includes(o.status) && o.payments.some((p) => p.status === 'paid')) {
    actions.push(
      h('button', {
        type: 'button',
        class: 'btn btn-sm ad-btn-danger',
        onclick: async () => {
          const reason = await askReason('Registrar reembolso', 'Use depois de estornar o valor no painel do gateway. Entregas ainda não aplicadas serão canceladas; entregas já feitas precisam ser removidas no jogo pela equipe.', 'Registrar reembolso', true);
          if (reason) run(`/api/admin/orders/${o.id}/refund`, { reason }, 'Reembolso registrado');
        },
      }, 'Registrar reembolso'),
    );
  }

  const info = [
    ['Jogador', `${o.gameAccount.nickname} (ID ${o.gameAccount.serverAccountId})`],
    ['Conta do site', o.user.email || o.user.name],
    ['Criado em', dateTime(o.createdAt)],
    ['Pago em', dateTime(o.paidAt)],
    ['Entregue em', dateTime(o.deliveredAt)],
    ['Expira em', o.status === 'pending' ? dateTime(o.expiresAt) : '—'],
  ];

  mount(
    view,
    h(
      'div',
      { class: 'cc-container' },
      h('a', { class: 'cc-back', href: '#/pedidos' }, icon('back', 16), 'Vendas'),
      h('div', { class: 'ad-head' }, h('h1', { class: 'cc-title' }, 'Pedido ', h('span', { class: 'text-accent' }, o.code)), statusBadge(o.status, ADMIN_ORDER_STATUS)),
      h('div', { class: 'ad-actions' }, actions),
      h(
        'div',
        { class: 'ad-two' },
        h(
          'section',
          { class: 'cc-panel' },
          h('h2', { class: 'cc-h3' }, 'Resumo'),
          h('dl', { class: 'ad-dl' }, info.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v)))),
          h('h3', { class: 'cc-h3 ad-mt' }, 'Itens'),
          h('ul', { class: 'cc-review-items' }, o.items.map((i) => h('li', null, h('span', null, `${i.quantity}× ${i.product_name} (${money(i.unit_price_cents)})`), h('strong', null, money(i.total_cents))))),
          h('div', { class: 'cc-summary-row' }, h('span', null, 'Subtotal'), h('span', null, money(o.subtotalCents))),
          h('div', { class: 'cc-summary-row' }, h('span', null, 'Descontos'), h('span', null, money(o.discountCents))),
          h('div', { class: 'cc-summary-row cc-summary-total' }, h('span', null, 'Total'), h('strong', null, money(o.totalCents))),
        ),
        h(
          'section',
          { class: 'cc-panel' },
          h('h2', { class: 'cc-h3' }, 'Pagamento'),
          o.payments.length
            ? o.payments.map((p) =>
                h(
                  'dl',
                  { class: 'ad-dl ad-payment' },
                  h('div', null, h('dt', null, 'Status interno'), h('dd', null, statusBadge(p.status, PAYMENT_STATUS))),
                  h('div', null, h('dt', null, 'Status no gateway'), h('dd', null, p.providerStatus || '—')),
                  h('div', null, h('dt', null, 'Método'), h('dd', null, `${p.method.toUpperCase()} · ${p.provider}`)),
                  h('div', null, h('dt', null, 'ID da transação'), h('dd', { class: 'ad-mono' }, p.transactionId || '—')),
                  h('div', null, h('dt', null, 'Valor'), h('dd', null, money(p.amountCents))),
                  h('div', null, h('dt', null, 'Última consulta'), h('dd', null, dateTime(p.lastCheckedAt))),
                ),
              )
            : h('p', { class: 'cc-muted' }, 'Nenhuma cobrança gerada.'),
          h('h3', { class: 'cc-h3 ad-mt' }, 'Entrega no jogo ', statusBadge(o.delivery.status === 'none' ? 'none' : o.delivery.status, { none: { label: 'Sem entregas', tone: 'muted' }, waiting: { label: 'Aguardando', tone: 'amber' }, partial: { label: `${o.delivery.delivered}/${o.delivery.total}`, tone: 'amber' }, delivered: { label: 'Concluída', tone: 'emerald' }, failed: { label: 'Com falha', tone: 'red' }, cancelled: { label: 'Cancelada', tone: 'muted' } })),
          o.deliveries.length
            ? h(
                'ul',
                { class: 'ad-deliveries' },
                o.deliveries.map((d) =>
                  h(
                    'li',
                    null,
                    h('div', null, h('strong', null, `${d.payload.product_name || d.type} #${d.unit_index + 1}`), h('small', { class: 'cc-muted ad-block' }, `${d.type} · tentativas: ${d.attempts}${d.delivered_at ? ` · entregue ${dateTime(d.delivered_at)}` : ''}`), d.last_error ? h('small', { class: 'cc-error ad-block' }, d.last_error) : null),
                    h(
                      'div',
                      { class: 'ad-delivery-actions' },
                      statusBadge(d.status, DELIVERY_STATUS),
                      ['pending', 'processing', 'failed'].includes(d.status) && o.status !== 'refunded'
                        ? h('button', {
                            type: 'button',
                            class: 'cc-link-btn',
                            onclick: async () => {
                              const reason = await askReason('Marcar como entregue', 'Use apenas se o benefício já foi aplicado manualmente no jogo.', 'Marcar entregue');
                              if (reason) run(`/api/admin/deliveries/${d.id}/deliver`, { reason }, 'Entrega registrada');
                            },
                          }, 'Entrega manual')
                        : null,
                      ['failed', 'processing'].includes(d.status)
                        ? h('button', { type: 'button', class: 'cc-link-btn', onclick: () => run(`/api/admin/deliveries/${d.id}/requeue`, {}, 'Entrega reenviada para a fila') }, 'Reenviar')
                        : null,
                    ),
                  ),
                ),
              )
            : h('p', { class: 'cc-muted' }, 'As entregas são criadas quando o pagamento é confirmado.'),
        ),
      ),
      h(
        'section',
        { class: 'cc-panel' },
        h('h2', { class: 'cc-h3' }, 'Histórico de eventos'),
        h(
          'ol',
          { class: 'ad-timeline' },
          o.events.map((e) =>
            h(
              'li',
              null,
              h('span', { class: 'ad-time' }, dateTime(e.created_at)),
              h(
                'div',
                null,
                h('strong', null, e.message || e.type),
                e.from_status || e.to_status ? h('small', { class: 'cc-muted ad-block' }, `${e.from_status || '—'} → ${e.to_status || '—'}`) : null,
                h('small', { class: 'cc-muted ad-block' }, `${SOURCE_LABEL[e.source] || e.source}${e.actor_email ? ` · ${e.actor_email}` : ''}`),
              ),
            ),
          ),
        ),
        o.transactions.length
          ? [
              h('h3', { class: 'cc-h3 ad-mt' }, 'Transações financeiras'),
              h('ul', { class: 'cc-review-items' }, o.transactions.map((t) => h('li', null, h('span', null, `${dateTime(t.created_at)} · ${t.type}`), h('strong', null, money(t.amount_cents))))),
            ]
          : null,
      ),
    ),
  );
}

/* --------------------------------------------------------------------------
   Produtos
   -------------------------------------------------------------------------- */
async function productsView(signal, query) {
  const q = new URLSearchParams(query);
  mount(view, h('div', { class: 'cc-container' }, pageHead('Produtos'), h('div', { class: 'cc-skel cc-skel-block' })));
  const [{ products }, { categories }] = await Promise.all([api(`/api/admin/products?${q.toString()}`, { signal }), api('/api/admin/categories', { signal })]);

  const catFilter = h(
    'select',
    { class: 'cc-select', onchange: (e) => (location.hash = e.target.value ? `#/produtos?categoryId=${e.target.value}` : '#/produtos') },
    h('option', { value: '' }, 'Todas as categorias'),
    categories.map((c) => h('option', { value: c.id, selected: q.get('categoryId') === c.id }, c.name)),
  );

  const move = async (index, dir) => {
    const ids = products.map((p) => p.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    if (await action(() => api('/api/admin/products/reorder', { method: 'POST', body: { ids } }), 'Ordem atualizada')) route();
  };

  const toggle = async (p, body, msg) => {
    if (await action(() => api(`/api/admin/products/${p.id}/status`, { method: 'POST', body }), msg)) route();
  };

  mount(
    view,
    h(
      'div',
      { class: 'cc-container' },
      pageHead('Produtos', h('a', { class: 'btn btn-primary btn-sm', href: '#/produto/novo' }, icon('plus', 14), 'Novo produto')),
      h('div', { class: 'ad-filters ad-filters-inline' }, catFilter),
      categories.length === 0
        ? emptyState('tag', 'Crie uma categoria primeiro', 'Os produtos precisam de uma categoria.', h('a', { class: 'btn btn-primary btn-sm', href: '#/categorias' }, 'Criar categoria'))
        : products.length === 0
          ? emptyState('box', 'Nenhum produto cadastrado', null, h('a', { class: 'btn btn-primary btn-sm', href: '#/produto/novo' }, 'Cadastrar produto'))
          : h(
              'ul',
              { class: 'ad-products' },
              products.map((p, i) =>
                h(
                  'li',
                  { class: `ad-product${p.isActive ? '' : ' ad-off'}` },
                  p.imageUrl ? h('div', { class: 'ad-thumb' }, img(p.imageUrl, '')) : h('div', { class: 'ad-thumb cc-img-placeholder' }, icon('image', 20)),
                  h(
                    'div',
                    { class: 'ad-product-info' },
                    h('a', { href: `#/produto/${p.id}`, class: 'ad-product-name' }, p.name),
                    h(
                      'small',
                      { class: 'cc-muted' },
                      `${p.categoryName} · ${p.promoPriceCents ? `${money(p.promoPriceCents)} (de ${money(p.priceCents)})` : money(p.priceCents)} · ${p.stock === null ? 'estoque ilimitado' : `${p.stock} em estoque`} · ${p.soldCount} vendidos`,
                    ),
                    h('div', { class: 'ad-tags' }, p.isActive ? h('span', { class: 'cc-badge cc-badge-emerald' }, 'Ativo') : h('span', { class: 'cc-badge cc-badge-muted' }, 'Inativo'), p.isFeatured ? h('span', { class: 'cc-badge cc-badge-blue' }, 'Destaque') : null),
                  ),
                  h(
                    'div',
                    { class: 'ad-product-actions' },
                    h('button', { type: 'button', class: 'cc-icon-btn', 'aria-label': 'Subir', disabled: i === 0, onclick: () => move(i, -1) }, icon('arrowUp', 16)),
                    h('button', { type: 'button', class: 'cc-icon-btn', 'aria-label': 'Descer', disabled: i === products.length - 1, onclick: () => move(i, 1) }, icon('arrowDown', 16)),
                    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => toggle(p, { isActive: !p.isActive }, p.isActive ? 'Produto desativado' : 'Produto ativado') }, p.isActive ? 'Desativar' : 'Ativar'),
                    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => toggle(p, { isFeatured: !p.isFeatured }, 'Destaque atualizado') }, p.isFeatured ? 'Tirar destaque' : 'Destacar'),
                    h('a', { class: 'btn btn-secondary btn-sm', href: `#/produto/${p.id}` }, icon('edit', 14), 'Editar'),
                  ),
                ),
              ),
            ),
    ),
  );
}

function deliveryFields(type, values, onChange) {
  const def = meta.deliveryTypes.find((t) => t.type === type);
  if (!def) return h('div');
  return h(
    'div',
    { class: 'ad-grid' },
    def.fields.map((f) => {
      const value = values[f.key] ?? '';
      let control;
      if (f.kind === 'select') {
        control = h('select', { class: 'cc-select', required: f.required, onchange: (e) => onChange(f.key, e.target.value) }, h('option', { value: '' }, 'Selecione'), f.options.map((o) => h('option', { value: o.value, selected: String(value) === o.value }, o.label)));
      } else {
        control = h('input', {
          class: 'cc-input',
          type: f.kind === 'integer' ? 'number' : 'text',
          inputmode: f.kind === 'integer' ? 'numeric' : null,
          step: f.kind === 'integer' ? 1 : null,
          min: f.min ?? null,
          max: f.max ?? null,
          required: f.required,
          value: String(value),
          oninput: (e) => onChange(f.key, e.target.value),
        });
      }
      return field(`${f.label}${f.required ? ' *' : ''}`, control, f.help);
    }),
  );
}

async function productFormView(signal, id) {
  mount(view, h('div', { class: 'cc-container cc-narrow' }, h('div', { class: 'cc-skel cc-skel-block' })));
  const [{ categories }, existing] = await Promise.all([api('/api/admin/categories', { signal }), id ? api(`/api/admin/products/${id}`, { signal }) : null]);
  if (!categories.length) {
    location.replace('#/categorias');
    return;
  }
  const p = existing ? existing.product : { categoryId: categories[0].id, name: '', slug: '', shortDescription: '', description: '', conditions: '', imageUrl: null, priceCents: null, promoPriceCents: null, promoEndsAt: null, stock: null, maxPerOrder: 1, benefits: [], durationDays: null, deliveryType: meta.deliveryTypes[0].type, deliveryParams: {}, isActive: true, isFeatured: false, sortOrder: 0 };
  const form = { ...p, benefits: [...p.benefits], deliveryParams: structuredClone(p.deliveryParams || {}) };

  const inp = (key, attrs = {}) => h('input', { class: 'cc-input', value: form[key] ?? '', oninput: (e) => (form[key] = e.target.value), ...attrs });
  const txt = (key, attrs = {}) => {
    const t = h('textarea', { class: 'cc-textarea', oninput: (e) => (form[key] = e.target.value), ...attrs });
    t.value = form[key] || '';
    return t;
  };

  // Imagem
  const preview = h('div', { class: 'ad-image-preview' });
  const renderPreview = () => mount(preview, form.imageUrl ? img(form.imageUrl, 'Prévia', { loading: 'eager' }) : h('div', { class: 'cc-img-placeholder ad-image-empty' }, icon('image', 28)));
  renderPreview();
  const fileInput = h('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    class: 'ad-file',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      const res = await action(() => api('/api/admin/uploads', { method: 'POST', body: fd }), 'Imagem enviada');
      if (res) {
        form.imageUrl = res.url;
        renderPreview();
      }
      e.target.value = '';
    },
  });

  // Benefícios (lista editável)
  const benefitsBox = h('div', { class: 'ad-benefits' });
  const renderBenefits = () =>
    mount(
      benefitsBox,
      form.benefits.map((b, i) =>
        h(
          'div',
          { class: 'ad-benefit-row' },
          h('input', { class: 'cc-input', value: b, maxlength: 120, oninput: (e) => (form.benefits[i] = e.target.value) }),
          h('button', { type: 'button', class: 'cc-icon-btn cc-danger', 'aria-label': 'Remover benefício', onclick: () => { form.benefits.splice(i, 1); renderBenefits(); } }, icon('x', 16)),
        ),
      ),
      form.benefits.length < 20 ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { form.benefits.push(''); renderBenefits(); } }, icon('plus', 14), 'Adicionar benefício') : null,
    );
  renderBenefits();

  // Entrega
  const deliveryBox = h('div');
  const renderDelivery = () => {
    if (form.deliveryType === 'bundle') {
      if (!Array.isArray(form.deliveryParams.items)) form.deliveryParams = { items: [] };
      const items = form.deliveryParams.items;
      mount(
        deliveryBox,
        items.map((item, i) =>
          h(
            'div',
            { class: 'ad-bundle-item' },
            h(
              'div',
              { class: 'ad-bundle-head' },
              h('select', { class: 'cc-select', onchange: (e) => { items[i] = { type: e.target.value, params: {} }; renderDelivery(); } }, meta.deliveryTypes.filter((t) => t.type !== 'bundle').map((t) => h('option', { value: t.type, selected: t.type === item.type }, t.label))),
              h('button', { type: 'button', class: 'cc-icon-btn cc-danger', 'aria-label': 'Remover item do pacote', onclick: () => { items.splice(i, 1); renderDelivery(); } }, icon('trash', 16)),
            ),
            deliveryFields(item.type, item.params, (k, v) => (item.params[k] = v)),
          ),
        ),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => { items.push({ type: 'coins', params: {} }); renderDelivery(); } }, icon('plus', 14), 'Adicionar benefício ao pacote'),
      );
    } else {
      const def = meta.deliveryTypes.find((t) => t.type === form.deliveryType);
      mount(deliveryBox, def ? h('p', { class: 'cc-muted' }, def.description) : null, deliveryFields(form.deliveryType, form.deliveryParams, (k, v) => (form.deliveryParams[k] = v)));
    }
  };
  renderDelivery();
  const typeSelect = h('select', { class: 'cc-select', onchange: (e) => { form.deliveryType = e.target.value; form.deliveryParams = {}; renderDelivery(); } }, meta.deliveryTypes.map((t) => h('option', { value: t.type, selected: t.type === form.deliveryType }, t.label)));

  const price = h('input', { class: 'cc-input', inputmode: 'decimal', required: true, placeholder: '0,00', value: centsToInput(form.priceCents) });
  const promo = h('input', { class: 'cc-input', inputmode: 'decimal', placeholder: 'Sem promoção', value: centsToInput(form.promoPriceCents) });
  const promoEnds = h('input', { class: 'cc-input', type: 'datetime-local', value: form.promoEndsAt ? new Date(new Date(form.promoEndsAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' });
  const stock = h('input', { class: 'cc-input', type: 'number', min: 0, step: 1, inputmode: 'numeric', placeholder: 'Ilimitado', value: form.stock ?? '' });
  const duration = h('input', { class: 'cc-input', type: 'number', min: 1, step: 1, inputmode: 'numeric', placeholder: 'Permanente', value: form.durationDays ?? '' });
  const durationHint = h('small', { class: 'cc-muted' }, durationLabel(form.durationDays));
  duration.addEventListener('input', () => (durationHint.textContent = durationLabel(Number(duration.value) || null)));

  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, id ? 'Salvar alterações' : 'Criar produto');
  const onSubmit = async (e) => {
    e.preventDefault();
    const priceCents = inputToCents(price.value);
    const promoCents = inputToCents(promo.value);
    if (!priceCents || Number.isNaN(priceCents)) return toast('Informe um preço válido.', 'error');
    if (Number.isNaN(promoCents)) return toast('Preço promocional inválido.', 'error');
    const body = {
      categoryId: form.categoryId,
      name: form.name,
      slug: form.slug || undefined,
      shortDescription: form.shortDescription,
      description: form.description,
      conditions: form.conditions,
      imageUrl: form.imageUrl,
      priceCents,
      promoPriceCents: promoCents,
      promoEndsAt: promoEnds.value ? new Date(promoEnds.value).toISOString() : null,
      stock: stock.value === '' ? null : Number(stock.value),
      maxPerOrder: Number(form.maxPerOrder) || 1,
      benefits: form.benefits.map((b) => b.trim()).filter(Boolean),
      durationDays: duration.value === '' ? null : Number(duration.value),
      deliveryType: form.deliveryType,
      deliveryParams: form.deliveryParams,
      isActive: form.isActive,
      isFeatured: form.isFeatured,
      sortOrder: Number(form.sortOrder) || 0,
    };
    submit.disabled = true;
    try {
      await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body });
      toast(id ? 'Produto atualizado' : 'Produto criado');
      location.hash = '#/produtos';
    } catch (err) {
      const detail = err instanceof ApiError && Array.isArray(err.details) && err.details[0] ? ` (${err.details[0].path})` : '';
      toast(`${err.message}${detail}`, 'error');
      submit.disabled = false;
    }
  };

  const remove = async () => {
    if (!(await confirmDialog('Remover produto', 'Se o produto já foi vendido, ele será arquivado para manter o histórico. Caso contrário, será excluído.', 'Remover', true))) return;
    const res = await action(() => api(`/api/admin/products/${id}`, { method: 'DELETE' }));
    if (res) {
      toast(res.archived ? 'Produto arquivado' : 'Produto excluído');
      location.hash = '#/produtos';
    }
  };

  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      h('a', { class: 'cc-back', href: '#/produtos' }, icon('back', 16), 'Produtos'),
      pageHead(id ? 'Editar produto' : 'Novo produto'),
      h(
        'form',
        { class: 'ad-form', onsubmit: onSubmit },
        h(
          'section',
          { class: 'cc-panel' },
          h('h2', { class: 'cc-h3' }, 'Informações'),
          field('Nome *', inp('name', { required: true, minlength: 2, maxlength: 80 })),
          field('Categoria *', h('select', { class: 'cc-select', onchange: (e) => (form.categoryId = e.target.value) }, categories.map((c) => h('option', { value: c.id, selected: c.id === form.categoryId }, `${c.name}${c.isActive ? '' : ' (inativa)'}`)))),
          field('Descrição curta', inp('shortDescription', { maxlength: 160 }), 'Aparece no card da loja.'),
          field('Descrição completa', txt('description', { maxlength: 5000 })),
          field('Condições', txt('conditions', { maxlength: 2000 }), 'Regras de uso, restrições, observações.'),
          field('Endereço (slug)', inp('slug', { maxlength: 80, placeholder: 'gerado a partir do nome' })),
        ),
        h(
          'section',
          { class: 'cc-panel' },
          h('h2', { class: 'cc-h3' }, 'Imagem'),
          h('div', { class: 'ad-image' }, preview, h('div', { class: 'ad-image-actions' }, h('label', { class: 'btn btn-secondary btn-sm ad-upload' }, icon('image', 14), 'Enviar imagem', fileInput), form.imageUrl ? h('button', { type: 'button', class: 'cc-link-btn', onclick: () => { form.imageUrl = null; renderPreview(); } }, 'Remover imagem') : null, h('small', { class: 'cc-muted' }, 'JPG, PNG ou WebP até 6 MB. A imagem é otimizada automaticamente.'))),
        ),
        h(
          'section',
          { class: 'cc-panel' },
          h('h2', { class: 'cc-h3' }, 'Preço e estoque'),
          h('div', { class: 'ad-grid' }, field('Preço (R$) *', price), field('Preço promocional (R$)', promo), field('Promoção válida até', promoEnds, 'Vazio = sem prazo'), field('Estoque', stock, 'Vazio = ilimitado'), field('Máximo por pedido', inp('maxPerOrder', { type: 'number', min: 1, max: 100, step: 1, inputmode: 'numeric' })), field('Duração (dias)', duration, durationHint)),
        ),
        h('section', { class: 'cc-panel' }, h('h2', { class: 'cc-h3' }, 'Benefícios exibidos'), benefitsBox),
        h('section', { class: 'cc-panel' }, h('h2', { class: 'cc-h3' }, 'Entrega no jogo'), field('Tipo de benefício', typeSelect), deliveryBox),
        h(
          'section',
          { class: 'cc-panel' },
          h('h2', { class: 'cc-h3' }, 'Exibição'),
          h('label', { class: 'ad-check' }, h('input', { type: 'checkbox', checked: form.isActive, onchange: (e) => (form.isActive = e.target.checked) }), 'Ativo (visível e à venda)'),
          h('label', { class: 'ad-check' }, h('input', { type: 'checkbox', checked: form.isFeatured, onchange: (e) => (form.isFeatured = e.target.checked) }), 'Destaque na página inicial'),
          field('Ordem de exibição', inp('sortOrder', { type: 'number', step: 1, inputmode: 'numeric' }), 'Menor aparece primeiro. Também é possível reordenar na lista.'),
        ),
        h('div', { class: 'cc-row cc-row-between' }, id ? h('button', { type: 'button', class: 'btn btn-sm ad-btn-danger', onclick: remove }, icon('trash', 14), 'Remover') : h('span'), submit),
      ),
    ),
  );
}

/* --------------------------------------------------------------------------
   Categorias
   -------------------------------------------------------------------------- */
async function categoriesView(signal) {
  mount(view, h('div', { class: 'cc-container cc-narrow' }, pageHead('Categorias'), h('div', { class: 'cc-skel cc-skel-block' })));
  const { categories } = await api('/api/admin/categories', { signal });
  const editor = h('div');

  const openEditor = (c) => {
    const form = c ? { ...c } : { name: '', slug: '', description: '', icon: 'tag', imageUrl: null, sortOrder: (categories.length + 1) * 10, isActive: true };
    const iconPicker = h(
      'div',
      { class: 'ad-icons', role: 'radiogroup', 'aria-label': 'Ícone' },
      meta.categoryIcons.map((name) =>
        h('button', {
          type: 'button',
          class: `ad-icon-opt${form.icon === name ? ' active' : ''}`,
          role: 'radio',
          'aria-checked': form.icon === name ? 'true' : 'false',
          'aria-label': name,
          onclick: (e) => {
            form.icon = name;
            iconPicker.querySelectorAll('.ad-icon-opt').forEach((b) => {
              b.classList.toggle('active', b === e.currentTarget);
              b.setAttribute('aria-checked', b === e.currentTarget ? 'true' : 'false');
            });
          },
        }, icon(name, 20)),
      ),
    );
    const imgState = h('small', { class: 'cc-muted' }, form.imageUrl ? 'Imagem definida' : 'Opcional');
    const file = h('input', {
      type: 'file',
      accept: 'image/jpeg,image/png,image/webp',
      class: 'ad-file',
      onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        const res = await action(() => api('/api/admin/uploads', { method: 'POST', body: fd }), 'Imagem enviada');
        if (res) {
          form.imageUrl = res.url;
          imgState.textContent = 'Imagem definida';
        }
      },
    });
    const name = h('input', { class: 'cc-input', required: true, minlength: 2, maxlength: 60, value: form.name });
    const desc = h('input', { class: 'cc-input', maxlength: 300, value: form.description });
    const active = h('input', { type: 'checkbox', checked: form.isActive });
    mount(
      editor,
      h(
        'form',
        {
          class: 'cc-panel ad-form',
          onsubmit: async (e) => {
            e.preventDefault();
            const body = { name: name.value, slug: form.slug || undefined, description: desc.value, icon: form.icon, imageUrl: form.imageUrl, sortOrder: form.sortOrder, isActive: active.checked };
            const res = await action(() => api(c ? `/api/admin/categories/${c.id}` : '/api/admin/categories', { method: c ? 'PUT' : 'POST', body }), c ? 'Categoria atualizada' : 'Categoria criada');
            if (res) route();
          },
        },
        h('h2', { class: 'cc-h3' }, c ? `Editar ${c.name}` : 'Nova categoria'),
        field('Nome *', name),
        field('Descrição', desc),
        h('div', { class: 'ad-field' }, h('span', { class: 'ad-label' }, 'Ícone'), iconPicker),
        h('div', { class: 'ad-field' }, h('span', { class: 'ad-label' }, 'Imagem'), h('label', { class: 'btn btn-secondary btn-sm ad-upload' }, icon('image', 14), 'Enviar imagem', file), imgState),
        h('label', { class: 'ad-check' }, active, 'Ativa (visível na loja)'),
        h('div', { class: 'cc-row cc-row-between' }, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => mount(editor) }, 'Fechar'), h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, 'Salvar')),
      ),
    );
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    name.focus();
  };

  const move = async (index, dir) => {
    const ids = categories.map((c) => c.id);
    const t = index + dir;
    if (t < 0 || t >= ids.length) return;
    [ids[index], ids[t]] = [ids[t], ids[index]];
    if (await action(() => api('/api/admin/categories/reorder', { method: 'POST', body: { ids } }), 'Ordem atualizada')) route();
  };

  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      pageHead('Categorias', h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => openEditor(null) }, icon('plus', 14), 'Nova categoria')),
      editor,
      categories.length
        ? h(
            'ul',
            { class: 'ad-products' },
            categories.map((c, i) =>
              h(
                'li',
                { class: `ad-product${c.isActive ? '' : ' ad-off'}` },
                h('div', { class: 'ad-thumb cc-img-placeholder' }, icon(c.icon, 20)),
                h('div', { class: 'ad-product-info' }, h('strong', null, c.name), h('small', { class: 'cc-muted' }, `${c.productCount} produto(s) · /${c.slug}`), h('div', { class: 'ad-tags' }, c.isActive ? h('span', { class: 'cc-badge cc-badge-emerald' }, 'Ativa') : h('span', { class: 'cc-badge cc-badge-muted' }, 'Inativa'))),
                h(
                  'div',
                  { class: 'ad-product-actions' },
                  h('button', { type: 'button', class: 'cc-icon-btn', 'aria-label': 'Subir', disabled: i === 0, onclick: () => move(i, -1) }, icon('arrowUp', 16)),
                  h('button', { type: 'button', class: 'cc-icon-btn', 'aria-label': 'Descer', disabled: i === categories.length - 1, onclick: () => move(i, 1) }, icon('arrowDown', 16)),
                  h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => openEditor(c) }, icon('edit', 14), 'Editar'),
                  c.productCount === 0
                    ? h('button', {
                        type: 'button',
                        class: 'btn btn-sm ad-btn-danger',
                        onclick: async () => {
                          if (!(await confirmDialog('Excluir categoria', `Excluir "${c.name}"?`, 'Excluir', true))) return;
                          if (await action(() => api(`/api/admin/categories/${c.id}`, { method: 'DELETE' }), 'Categoria excluída')) route();
                        },
                      }, 'Excluir')
                    : null,
                ),
              ),
            ),
          )
        : emptyState('tag', 'Nenhuma categoria', 'Crie categorias como VIP, Moedas e Veículos para organizar a loja.'),
    ),
  );
}

/* --------------------------------------------------------------------------
   Auditoria
   -------------------------------------------------------------------------- */
const AUDIT_LABEL = {
  'product.created': 'Produto criado',
  'product.updated': 'Produto editado',
  'product.price_changed': 'Preço alterado',
  'product.activated': 'Produto ativado',
  'product.deactivated': 'Produto desativado',
  'product.featured_changed': 'Destaque alterado',
  'product.removed': 'Produto removido',
  'product.reordered': 'Produtos reordenados',
  'category.created': 'Categoria criada',
  'category.updated': 'Categoria editada',
  'category.deleted': 'Categoria excluída',
  'category.reordered': 'Categorias reordenadas',
  'order.cancelled': 'Pedido cancelado',
  'order.refunded': 'Reembolso registrado',
  'order.approved_manually': 'Pedido aprovado manualmente',
  'order.payment_rechecked': 'Pagamento reconsultado',
  'delivery.manual': 'Entrega manual',
  'delivery.requeued': 'Entrega reenviada',
  'upload.created': 'Imagem enviada',
  'user.admin_granted': 'Administrador adicionado',
};

function auditDetails(log) {
  const d = log.data || {};
  if (d.changes) {
    return Object.entries(d.changes)
      .map(([k, v]) => `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`)
      .join(' · ');
  }
  return [d.name, d.code, d.reason].filter(Boolean).join(' · ');
}

async function auditView(signal, query) {
  const q = new URLSearchParams(query);
  const page = Number(q.get('page') || 1);
  mount(view, h('div', { class: 'cc-container' }, pageHead('Auditoria'), h('div', { class: 'cc-skel cc-skel-block' })));
  const data = await api(`/api/admin/audit?page=${page}`, { signal });
  const link = (log) => {
    if (log.entity_type === 'order' && log.entity_id) return `#/pedido/${log.entity_id}`;
    if (log.entity_type === 'product' && log.entity_id && log.action !== 'product.removed') return `#/produto/${log.entity_id}`;
    return null;
  };
  mount(
    view,
    h(
      'div',
      { class: 'cc-container' },
      pageHead('Auditoria'),
      data.logs.length
        ? tableOrCards(
            [
              { label: 'Data', render: (l) => dateTime(l.created_at) },
              { label: 'Administrador', render: (l) => l.actor_label },
              { label: 'Ação', render: (l) => (link(l) ? h('a', { href: link(l), class: 'text-accent' }, AUDIT_LABEL[l.action] || l.action) : AUDIT_LABEL[l.action] || l.action) },
              { label: 'Detalhes', class: 'ad-col-items', render: (l) => auditDetails(l) || '—' },
            ],
            data.logs,
          )
        : emptyState('shield', 'Nenhum registro ainda', 'Ações administrativas importantes aparecem aqui.'),
      h(
        'div',
        { class: 'ad-pager' },
        h('a', { class: 'btn btn-secondary btn-sm', href: `#/auditoria?page=${page - 1}`, hidden: page <= 1 }, 'Anterior'),
        h('a', { class: 'btn btn-secondary btn-sm', href: `#/auditoria?page=${page + 1}`, hidden: !data.hasMore }, 'Próxima'),
      ),
    ),
  );
}

/* --------------------------------------------------------------------------
   Roteador e acesso
   -------------------------------------------------------------------------- */
const routes = [
  [/^#?\/?$/, 'dashboard', (s) => dashboardView(s)],
  [/^#\/pedidos(?:\?(.*))?$/, 'orders', (s, m) => ordersView(s, m[1] || '')],
  [/^#\/pedido\/([0-9a-f-]{36})$/i, 'orders', (s, m) => orderDetailView(s, m[1])],
  [/^#\/produtos(?:\?(.*))?$/, 'products', (s, m) => productsView(s, m[1] || '')],
  [/^#\/produto\/novo$/, 'products', (s) => productFormView(s, null)],
  [/^#\/produto\/([0-9a-f-]{36})$/i, 'products', (s, m) => productFormView(s, m[1])],
  [/^#\/categorias$/, 'categories', (s) => categoriesView(s)],
  [/^#\/auditoria(?:\?(.*))?$/, 'audit', (s, m) => auditView(s, m[1] || '')],
];

async function route() {
  if (routeController) routeController.abort();
  routeController = new AbortController();
  const signal = routeController.signal;
  const hash = location.hash || '#/';
  const found = routes.map(([re, name, fn]) => [hash.match(re), name, fn]).find(([m]) => m) || [[], 'dashboard', (s) => dashboardView(s)];
  const [m, name, fn] = found;
  document.querySelectorAll('#ad-nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  try {
    await fn(signal, m);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return gate(err.status);
    mount(view, h('div', { class: 'cc-container' }, errorState(err, () => route())));
  }
  if (!signal.aborted) window.scrollTo(0, 0);
}

function gate(status) {
  document.getElementById('ad-nav').hidden = true;
  if (status === 401) {
    // Depois do login com Google o servidor redireciona de volta para o painel.
    document.cookie = 'cc_return=admin; path=/; max-age=600; SameSite=Lax';
  }
  mount(
    view,
    h(
      'div',
      { class: 'cc-container cc-narrow' },
      emptyState(
        'shield',
        status === 401 ? 'Entre para acessar o painel' : 'Acesso restrito',
        status === 401 ? 'Use uma conta Google com permissão de administrador.' : 'Sua conta não tem permissão de administrador.',
        h('a', { class: 'btn btn-primary btn-sm', href: '../store/#/conta' }, status === 401 ? 'Entrar' : 'Voltar para a loja'),
      ),
    ),
  );
}

document.addEventListener('DOMContentLoaded', async () => {
  mount(document.getElementById('ad-store-link'), icon('bag', 20));
  watchConnection();
  try {
    meta = await api('/api/admin/meta');
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return gate(err.status);
    mount(view, h('div', { class: 'cc-container' }, errorState(err, () => location.reload())));
    return;
  }
  window.addEventListener('hashchange', route);
  route();
});
