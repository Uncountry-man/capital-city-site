-- Loja Capital City: modelo inicial
-- Valores monetários sempre em centavos (integer) para evitar erros de ponto flutuante.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Usuários (jogadores/clientes e administradores), sessões e contas do jogo
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub      text UNIQUE,
  email           text,
  name            text NOT NULL DEFAULT '',
  avatar_url      text,
  role            text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);
CREATE INDEX users_email_idx ON users (lower(email));

-- O token de sessão nunca é salvo em texto puro: guardamos apenas o SHA-256.
CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Conta dentro do servidor SA-MP. Uma conta do site pode ter várias contas no jogo.
CREATE TABLE game_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_account_id  text NOT NULL UNIQUE,
  nickname           text NOT NULL,
  google_sub         text,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  linked_at          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX game_accounts_user_idx ON game_accounts (user_id);
CREATE INDEX game_accounts_google_sub_idx ON game_accounts (google_sub);

-- Código temporário para vincular a conta do site a uma conta do jogo (/vincular CODIGO).
CREATE TABLE link_codes (
  code_hash   text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX link_codes_user_idx ON link_codes (user_id);

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  icon         text NOT NULL DEFAULT 'tag',
  image_url    text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX categories_active_sort_idx ON categories (is_active, sort_order);

CREATE TABLE products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id        uuid NOT NULL REFERENCES categories(id),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  short_description  text NOT NULL DEFAULT '',
  description        text NOT NULL DEFAULT '',
  conditions         text NOT NULL DEFAULT '',
  image_url          text,
  price_cents        integer NOT NULL CHECK (price_cents > 0),
  promo_price_cents  integer CHECK (promo_price_cents IS NULL OR promo_price_cents > 0),
  promo_ends_at      timestamptz,
  stock              integer CHECK (stock IS NULL OR stock >= 0), -- NULL = ilimitado
  max_per_order      integer NOT NULL DEFAULT 1 CHECK (max_per_order BETWEEN 1 AND 100),
  benefits           jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_days      integer CHECK (duration_days IS NULL OR duration_days > 0), -- NULL = permanente
  delivery_type      text NOT NULL,
  delivery_params    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active          boolean NOT NULL DEFAULT true,
  is_featured        boolean NOT NULL DEFAULT false,
  sort_order         integer NOT NULL DEFAULT 0,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_listing_idx ON products (category_id, is_active, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX products_featured_idx ON products (is_featured) WHERE deleted_at IS NULL AND is_active;

-- ---------------------------------------------------------------------------
-- Cupons (estrutura preparada para uso futuro)
-- ---------------------------------------------------------------------------
CREATE TABLE coupons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value            integer NOT NULL CHECK (value > 0), -- percent: 1..100, fixed: centavos
  min_order_cents  integer NOT NULL DEFAULT 0,
  max_uses         integer,
  used_count       integer NOT NULL DEFAULT 0,
  starts_at        timestamptz,
  ends_at          timestamptz,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE, -- identificador curto exibido ao jogador/admin
  user_id          uuid NOT NULL REFERENCES users(id),
  game_account_id  uuid NOT NULL REFERENCES game_accounts(id),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending', 'processing', 'paid', 'approved', 'cancelled',
                     'expired', 'refunded', 'failed', 'delivered')),
  subtotal_cents   integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents   integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents      integer NOT NULL CHECK (total_cents > 0),
  currency         text NOT NULL DEFAULT 'BRL',
  coupon_id        uuid REFERENCES coupons(id),
  idempotency_key  text,
  stock_reserved   boolean NOT NULL DEFAULT false,
  expires_at       timestamptz NOT NULL,
  paid_at          timestamptz,
  approved_at      timestamptz,
  delivered_at     timestamptz,
  cancelled_at     timestamptz,
  refunded_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_status_created_idx ON orders (status, created_at DESC);
CREATE INDEX orders_created_idx ON orders (created_at DESC);
CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'pending';

CREATE TABLE order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id),
  product_name      text NOT NULL,
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents > 0),
  quantity          integer NOT NULL CHECK (quantity > 0),
  total_cents       integer NOT NULL CHECK (total_cents > 0),
  delivery_type     text NOT NULL,
  delivery_params   jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_days     integer
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);

-- Histórico de mudanças de status de cada pedido (exibido no painel).
CREATE TABLE order_events (
  id             bigserial PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type           text NOT NULL,
  from_status    text,
  to_status      text,
  source         text NOT NULL CHECK (source IN ('system', 'player', 'webhook', 'reconcile', 'admin', 'game')),
  actor_user_id  uuid REFERENCES users(id),
  message        text NOT NULL DEFAULT '',
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

-- ---------------------------------------------------------------------------
-- Pagamentos, transações financeiras e webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  uuid NOT NULL REFERENCES orders(id),
  provider                  text NOT NULL,
  method                    text NOT NULL DEFAULT 'pix',
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN (
                              'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
  provider_status           text,
  provider_transaction_id   text,
  amount_cents              integer NOT NULL CHECK (amount_cents > 0),
  pix_copy_paste            text,
  expires_at                timestamptz NOT NULL,
  paid_at                   timestamptz,
  last_checked_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_transaction_id)
);
CREATE INDEX payments_order_idx ON payments (order_id);
-- No máximo uma cobrança pendente por pedido.
CREATE UNIQUE INDEX payments_one_pending_per_order ON payments (order_id) WHERE status = 'pending';

-- Eventos financeiros importantes (livro-razão simples).
CREATE TABLE transactions (
  id            bigserial PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders(id),
  payment_id    uuid REFERENCES payments(id),
  type          text NOT NULL CHECK (type IN (
                  'charge_created', 'payment_confirmed', 'payment_failed', 'payment_expired',
                  'amount_mismatch', 'late_payment', 'refund')),
  amount_cents  integer NOT NULL DEFAULT 0,
  provider_ref  text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_order_idx ON transactions (order_id);
-- Uma única confirmação/reembolso por pagamento: barreira final contra processamento duplicado.
CREATE UNIQUE INDEX transactions_once_per_payment ON transactions (payment_id, type)
  WHERE type IN ('payment_confirmed', 'refund');

CREATE TABLE webhook_events (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  dedupe_key    text NOT NULL,
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'error')),
  payload       jsonb NOT NULL,
  error         text,
  attempts      integer NOT NULL DEFAULT 1,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (provider, dedupe_key)
);

-- ---------------------------------------------------------------------------
-- Entregas no jogo (consumidas pelo servidor SA-MP via API)
-- ---------------------------------------------------------------------------
CREATE TABLE deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  order_item_id      uuid NOT NULL REFERENCES order_items(id),
  unit_index         integer NOT NULL DEFAULT 0,
  user_id            uuid NOT NULL REFERENCES users(id),
  product_id         uuid NOT NULL REFERENCES products(id),
  game_account_id    uuid NOT NULL REFERENCES game_accounts(id),
  server_account_id  text NOT NULL,
  type               text NOT NULL,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN (
                       'pending', 'processing', 'delivered', 'failed', 'cancelled')),
  attempts           integer NOT NULL DEFAULT 0,
  claimed_at         timestamptz,
  delivered_at       timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id, unit_index)
);
CREATE INDEX deliveries_pending_idx ON deliveries (server_account_id, created_at) WHERE status IN ('pending', 'processing');
CREATE INDEX deliveries_order_idx ON deliveries (order_id);

-- ---------------------------------------------------------------------------
-- Auditoria administrativa
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  actor_user_id  uuid REFERENCES users(id),
  actor_label    text NOT NULL,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
