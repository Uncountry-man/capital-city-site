# Loja Capital City — guia de implantação e integração

Este documento cobre a loja do jogador (`/store/`), o painel de vendas (`/admin/`) e a API em `server/`.

- [Como funciona](#como-funciona)
- [Provedor de pagamento](#provedor-de-pagamento)
- [Hospedagem](#hospedagem)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Primeiro acesso](#primeiro-acesso)
- [Fluxo de pagamento](#fluxo-de-pagamento)
- [Integração com o servidor SA-MP](#integração-com-o-servidor-sa-mp)
- [Integração com o launcher](#integração-com-o-launcher)
- [Reembolsos](#reembolsos)
- [Segurança](#segurança)
- [Desenvolvimento e testes](#desenvolvimento-e-testes)

---

## Como funciona

```
Navegador / launcher ──► Node (server/) ──► PostgreSQL
                              │   ▲
                 cobrança PIX │   │ webhook + consulta
                              ▼   │
                             BSPay
                              
Servidor SA-MP ──(X-Game-Api-Key)──► /api/game/*  (fila de entregas)
```

- O processo Node serve **o site inteiro** (páginas estáticas atuais, `/store/`, `/admin/`) e a API `/api/*` no mesmo domínio. Assim o login usa um cookie de sessão próprio (`httpOnly`, `SameSite=Lax`) e não há CORS para configurar.
- O banco é a fonte da verdade: preços, pedidos, pagamentos, transações, entregas e auditoria.
- O servidor do jogo **não recebe chamadas**: ele consulta a fila de entregas da API, aplica o benefício e confirma. Se o servidor estiver fora do ar, nada se perde; as entregas ficam na fila.

Estrutura:

| Pasta | Conteúdo |
| --- | --- |
| `store/` | Loja do jogador (HTML + CSS + JS sem framework, reaproveita `css/style.css`) |
| `admin/` | Painel de vendas (mesmos componentes visuais) |
| `server/src/` | API Fastify + TypeScript |
| `server/src/db/migrations/` | Esquema do banco (aplicado automaticamente ao iniciar) |
| `server/test/` | Testes automatizados do fluxo completo |

> **GitHub Pages não executa backend.** O site institucional continua funcionando no Pages, mas a loja só funciona quando o `server/` está rodando. Para ter tudo num domínio só, publique o projeto inteiro no servidor Node (ele serve as páginas estáticas também).

## Provedor de pagamento

O Client ID `investcapital26_lx0zcscghtsexndr` segue o formato `usuario_codigo` usado pela **BSPay** (a própria documentação mostra `usuarioteste_63c4ff6423765as` como exemplo). A integração segue a documentação oficial em <https://bspay.readme.io/reference>:

| Uso | Endpoint |
| --- | --- |
| Token de acesso | `POST /v2/oauth/token` com `Authorization: Basic base64(client_id:client_secret)` |
| Gerar PIX | `POST /v2/pix/qrcode` (`amount`, `external_id`, `payerQuestion`, `payer`, `postbackUrl`) |
| Consultar transação | `POST /v2/consult-transaction` (`pix_id`) |
| Webhook | `POST` no `postbackUrl` informado em cada cobrança |

Se a sua conta for de outro provedor, só é preciso trocar o adaptador em `server/src/modules/payments/` (a interface `PaymentProvider` isola o restante do sistema).

**O Client Secret nunca vai para o código nem para o repositório.** Ele é lido somente da variável de ambiente `PAYMENT_SECRET` no servidor. Se o painel da BSPay pedir IP fixo para liberar a API, cadastre o IP do servidor onde o Node roda.

## Hospedagem

Requisitos: Node.js 20.11+ (recomendado 22), PostgreSQL 14+ e HTTPS (o PIX e o login Google exigem). Funciona em VPS (com Nginx/Caddy na frente) ou em plataformas como Render, Railway e Fly.io.

```bash
cd server
npm ci
npm run build
cp .env.example .env      # preencha os valores (veja a tabela abaixo)
npm start                 # aplica as migrações e sobe na porta PORT
```

Para manter rodando numa VPS, use `pm2` ou um serviço `systemd` executando `npm start` dentro de `server/`. Aponte o domínio (ex.: `capitalcityrp.com`) para o proxy reverso, que encaminha para `http://127.0.0.1:3000`, e deixe `TRUST_PROXY=true`.

Imagens enviadas pelo painel ficam em `UPLOAD_DIR` (padrão `server/uploads`). Em plataformas com disco efêmero, monte um volume persistente nesse caminho.

## Variáveis de ambiente

Todas ficam **somente no servidor** (`server/.env` ou o painel de variáveis da hospedagem). O arquivo `.env` está no `.gitignore`.

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `NODE_ENV` | sim | `production` em produção |
| `PORT` / `HOST` | não | Padrão `3000` / `0.0.0.0` |
| `TRUST_PROXY` | sim atrás de proxy | `true` para ler o IP real (rate limit, logs) |
| `DATABASE_URL` | sim | `postgres://usuario:senha@host:5432/banco` |
| `DATABASE_SSL` | não | `true` se o banco exigir SSL |
| `PUBLIC_BASE_URL` | sim | Endereço público com `https://` (usado no webhook e no login) |
| `CORS_ORIGINS` | não | Outras origens autorizadas a chamar a API com cookie |
| `GOOGLE_CLIENT_IDS` | sim | Client ID(s) OAuth do Google, separados por vírgula |
| `ADMIN_EMAILS` | não | E-mails Google que viram administradores ao entrar |
| `PAYMENT_PROVIDER` | sim | `bspay` |
| `PAYMENT_API_BASE_URL` | sim | `https://api.bspay.co` (confirme no painel da BSPay) |
| `PAYMENT_CLIENT_ID` | sim | `investcapital26_lx0zcscghtsexndr` |
| `PAYMENT_SECRET` | sim | Client Secret da BSPay (**privado**) |
| `PAYMENT_WEBHOOK_SECRET` | sim | Segredo aleatório de 24+ caracteres: `openssl rand -hex 32` |
| `PAYMENT_WEBHOOK_ALLOWED_IPS` | não | IPs de origem do webhook, se a BSPay informar |
| `PAYMENT_EXPIRATION_MINUTES` | não | Validade do PIX (padrão 30) |
| `GAME_API_KEY` | sim | Chave do servidor SA-MP (32+ caracteres): `openssl rand -hex 32` |
| `GAME_API_ALLOWED_IPS` | recomendado | IP(s) do servidor do jogo |
| `UPLOAD_DIR` | não | Pasta das imagens enviadas (padrão `uploads`) |

Em produção o servidor se recusa a iniciar se faltar alguma credencial obrigatória ou se `PAYMENT_PROVIDER=mock`.

### Login com Google

1. No [Google Cloud Console](https://console.cloud.google.com/apis/credentials), crie uma credencial **ID do cliente OAuth → Aplicativo da Web**.
2. Em *Origens JavaScript autorizadas*, adicione `https://seu-dominio`.
3. Em *URIs de redirecionamento autorizados*, adicione `https://seu-dominio/api/auth/google/redirect`.
4. Coloque o Client ID em `GOOGLE_CLIENT_IDS`. Se o launcher usar outro Client ID (ex.: Android), adicione-o separado por vírgula.

O login usa o modo *redirect* do Google (sem popup), que funciona dentro de WebView.

## Primeiro acesso

1. Suba o servidor e entre na loja com sua conta Google.
2. Torne-se administrador: coloque seu e-mail em `ADMIN_EMAILS` e entre de novo, ou rode `npm run admin:grant -- seu@email.com` (em produção, sem as dependências de desenvolvimento: `node --env-file=.env dist/scripts/grant-admin.js seu@email.com`).
3. Opcional: crie as categorias iniciais (VIP, Moedas, Veículos, Propriedades, Pacotes) com `npm run seed:categories` (ou `node --env-file=.env dist/scripts/seed-categories.js`).
4. Acesse `/admin/`, cadastre os produtos e ative-os.

No cadastro do produto, a seção **Entrega no jogo** define o que o servidor SA-MP vai aplicar (VIP, moedas, veículo, propriedade, item, skin, benefício genérico ou um pacote com vários). Os campos aparecem conforme o tipo escolhido; nada é digitado em JSON.

## Fluxo de pagamento

1. O jogador escolhe produtos e a conta do jogo que vai receber.
2. O frontend envia apenas `productId` e `quantity`.
3. O backend busca preço, promoção, estoque e limites no banco e calcula o total. Qualquer valor enviado pelo navegador é ignorado.
4. O pedido é criado com status `pending`, código único (`CC-XXXXXXXX`) e prazo de pagamento; o estoque fica reservado.
5. O backend gera a cobrança PIX na BSPay com o `external_id` interno e o `postbackUrl` do webhook.
6. O jogador vê o QR Code e o copia-e-cola. A tela consulta o status periodicamente.
7. A BSPay chama o webhook.
8. O webhook confere o segredo da URL, registra o evento e **consulta a transação na BSPay** antes de acreditar nele.
9. Se a BSPay confirmar `PAID` com o mesmo valor e o mesmo `external_id`, o pedido vira `paid` e depois `approved`.
10. São criadas as entregas (uma por unidade comprada) para o servidor do jogo.
11. Quando o servidor confirma, a entrega e o pedido viram `delivered`.

Status do pedido: `pending`, `processing` (pagamento com divergência, aguardando análise no painel), `paid`, `approved`, `delivered`, `cancelled`, `expired`, `refunded`, `failed`.

Garantias:

- **Idempotência:** o mesmo webhook (ou webhooks repetidos, ou webhook + consulta ao mesmo tempo) confirma o pagamento uma única vez; as entregas têm chave única por unidade, então nunca são duplicadas.
- **Reconciliação:** se o webhook não chegar, a tela do jogador e uma rotina a cada minuto consultam a BSPay. Pedidos vencidos expiram e devolvem o estoque. Um pagamento que chega depois do vencimento é registrado e o pedido é aprovado mesmo assim.
- **Divergência de valor:** o pedido vai para `processing` e aparece no painel para aprovação manual com motivo registrado.

O endereço do webhook é montado automaticamente e enviado em cada cobrança: `PUBLIC_BASE_URL/api/webhooks/payment?token=PAYMENT_WEBHOOK_SECRET`. Não é preciso cadastrá-lo no painel da BSPay.

## Integração com o servidor SA-MP

Todas as chamadas levam o header `X-Game-Api-Key: <GAME_API_KEY>` e corpo JSON. Restrinja também o IP com `GAME_API_ALLOWED_IPS`.

> O `HTTP()` nativo do SA-MP não envia headers nem usa HTTPS. Use um plugin como o [pawn-requests](https://github.com/Southclaws/pawn-requests) (headers, JSON e HTTPS) ou um pequeno serviço auxiliar ao lado do servidor.

### 1. Vincular a conta do jogo

Como o jogo já usa login Google, o caminho automático é informar o `sub` do Google ao sincronizar a conta; se ele for igual ao da conta do site, o vínculo é feito na hora.

```http
POST /api/game/accounts/sync
{ "serverAccountId": "1001", "nickname": "Joao_Silva", "googleSub": "1098765..." }
→ { "gameAccountId": "uuid", "linked": true }
```

Alternativa manual: na loja, em **Minha conta**, o jogador gera um código de 8 caracteres (válido por 15 minutos) e digita `/vincular CODIGO` no jogo. O comando chama:

```http
POST /api/game/accounts/link
{ "code": "AB12CD34", "serverAccountId": "1001", "nickname": "Joao_Silva" }
→ { "gameAccountId": "uuid", "linked": true }
```

Códigos são de uso único, e uma conta já vinculada a outro jogador não pode ser tomada.

### 2. Processar a fila de entregas

Recomendado: a cada 30–60 segundos, e também quando um jogador entra no servidor.

```http
GET /api/game/deliveries?limit=50                 (todas)
GET /api/game/deliveries?serverAccountId=1001     (só de um jogador)
→ { "deliveries": [ { "id", "orderId", "serverAccountId", "type", "payload", "status", "attempts", "createdAt" } ] }
```

Para cada entrega:

1. `POST /api/game/deliveries/{id}/claim` reserva a entrega por 10 minutos. Se responder `409`, outro processo já pegou; pule.
2. Aplique o benefício na conta `serverAccountId` (o jogador pode estar offline; grave no banco do jogo).
3. Confirme com `POST /api/game/deliveries/{id}/complete` (`{ "note": "opcional" }`). Repetir a confirmação é seguro.
4. Se não der para aplicar: `POST /api/game/deliveries/{id}/fail` com `{ "reason": "texto", "retry": true }` para tentar de novo depois, ou `retry: false` para marcar como falha e deixar a equipe resolver no painel.

Uma entrega reservada e não confirmada em 10 minutos volta para a fila automaticamente.

### Formato do `payload`

```json
{
  "order_code": "CC-7K2M9QXA",
  "product_id": "uuid",
  "product_name": "VIP Ouro 30 dias",
  "type": "vip",
  "params": { "tier": "ouro" },
  "duration_days": 30
}
```

`duration_days` é `null` para benefícios permanentes. Parâmetros por tipo:

| `type` | `params` |
| --- | --- |
| `vip` | `{ "tier": "ouro" }` |
| `coins` | `{ "amount": 50000, "currency": "coins" }` (`currency` opcional) |
| `vehicle` | `{ "model_id": 560, "color1": 1, "color2": 0 }` (cores opcionais) |
| `property` | `{ "property_type": "house" \| "business", "property_id": 12 }` (`property_id` opcional) |
| `item` | `{ "item_id": "kit_medico", "amount": 3 }` |
| `skin` | `{ "skin_id": 294 }` |
| `perk` | `{ "perk_key": "name_change", "value": "opcional" }` |
| `bundle` | `{ "items": [ { "type": "vip", "params": { "tier": "prata" } }, { "type": "coins", "params": { "amount": 20000 } } ] }` |

Um pacote (`bundle`) é uma entrega só: aplique todos os itens e confirme uma vez.

## Integração com o launcher

A API REST é a mesma usada pela loja web.

- **Login nativo:** o launcher obtém o ID token do Google e chama `POST /api/auth/google` com `{ "credential": "<id_token>", "mode": "token" }`. A resposta traz `token`, que vai em `Authorization: Bearer <token>` nas chamadas seguintes.
- **Abrir a loja dentro do app:** carregue `https://seu-dominio/store/?embed=1#token=<token>` numa WebView. O `embed=1` esconde links externos e rodapé; o token é lido do endereço, guardado só naquela aba e removido da URL.
- Principais rotas: `GET /api/store/categories`, `GET /api/store/products`, `GET /api/store/products/{id}`, `GET /api/me`, `POST /api/store/orders`, `GET /api/store/orders`, `GET /api/store/orders/{id}`, `POST /api/payments/create`, `GET /api/payments/{id}/status`.

## Reembolsos

A documentação pública da BSPay não tem rota de estorno. O estorno é feito no painel da BSPay e depois registrado no painel da loja (**Vendas → pedido → Registrar reembolso**, com motivo). Entregas ainda não aplicadas são canceladas; benefícios já entregues precisam ser removidos no jogo pela equipe.

## Segurança

- Preço sempre calculado no servidor; o frontend envia só produto e quantidade.
- Produto nunca é liberado por causa de uma página de sucesso: só pela confirmação consultada na BSPay.
- Webhook com segredo na URL, comparação em tempo constante, consulta obrigatória ao gateway, eventos deduplicados e dados pessoais removidos antes de gravar.
- Sessões com token aleatório guardado como hash, cookie `httpOnly`/`Secure`/`SameSite=Lax`, verificação de `Origin` em todas as rotas que alteram dados (CSRF).
- Pedidos e pagamentos sempre filtrados pelo dono (IDs de outros jogadores retornam 404) e identificados por UUID.
- Consultas SQL parametrizadas; conteúdo dinâmico inserido no HTML só como texto (XSS); CSP restritiva em `/store`, `/admin` e `/api`.
- Rate limit em login, criação de pedidos, pagamentos e webhook.
- Rotas `/api/admin/*` exigem papel de administrador; ações importantes ficam na auditoria (alterações de preço, produtos, categorias, cancelamentos, reembolsos, entregas manuais).
- Logs sem segredos: a query string (que contém o token do webhook) não é registrada e headers sensíveis são ocultados.
- Arquivos do servidor (`server/`, `.env`, `.git`) nunca são servidos como estáticos.

## Desenvolvimento e testes

```bash
cd server
npm install
createdb cc_dev && createdb cc_test        # PostgreSQL local
cp .env.example .env                       # ajuste para desenvolvimento:
#   NODE_ENV=development
#   DATABASE_URL=postgres://.../cc_dev
#   PUBLIC_BASE_URL=http://localhost:3000
#   PAYMENT_PROVIDER=mock                   # gateway simulado, recusado em produção
#   DEV_LOGIN=true                          # login sem Google, só em desenvolvimento
npm run dev                                # http://localhost:3000/store/

TEST_DATABASE_URL=postgres://.../cc_test npm test
npm run typecheck
```

Os testes sobem a aplicação real contra um PostgreSQL de teste e cobrem: criação de pedido, preço imutável, geração do PIX, webhook (antecipado, forjado, repetido e concorrente), confirmação, idempotência, registro da venda, criação e confirmação de entregas, painel administrativo, autorização (IDOR, CSRF, admin) e o adaptador da BSPay.
