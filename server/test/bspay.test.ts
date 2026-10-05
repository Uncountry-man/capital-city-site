import { describe, expect, it } from 'vitest';
import { BsPayProvider, mapBsPayStatus } from '../src/modules/payments/bspay.js';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Record<string, (body: any) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const path = new URL(url).pathname;
    const handler = responses[path];
    if (!handler) return new Response('{}', { status: 404 });
    const r = handler(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const CLIENT_ID = 'investcapital26_lx0zcscghtsexndr';

describe('BsPayProvider (formato da API oficial)', () => {
  it('autentica com Basic client_id:client_secret, gera QR Code e reaproveita o token', async () => {
    const { calls, impl } = fakeFetch({
      '/v2/oauth/token': () => ({ json: { access_token: 'tok-1', expires_in: 1800 } }),
      '/v2/pix/qrcode': (b) => ({ json: { transactionId: 'tx_123', external_id: b.external_id, status: 'PENDING', amount: b.amount, qrcode: '000201...' } }),
    });
    const p = new BsPayProvider({ baseUrl: 'https://api.bspay.co', clientId: CLIENT_ID, clientSecret: 'segredo', fetchImpl: impl });
    const charge = await p.createPixCharge({
      externalId: 'pay-1',
      amountCents: 1990,
      description: 'Pedido CC-1',
      payer: { name: 'Jogador', email: null },
      postbackUrl: 'https://capitalcityrp.com/api/webhooks/payment?token=x',
    });
    await p.createPixCharge({ externalId: 'pay-2', amountCents: 500, description: 'x', payer: { name: 'J', email: 'j@x.com' }, postbackUrl: 'https://a/b' });

    expect(charge).toEqual({ transactionId: 'tx_123', pixCopyPaste: '000201...', providerStatus: 'PENDING' });
    const tokenCalls = calls.filter((c) => c.url.endsWith('/v2/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:segredo`).toString('base64')}`);
    const qr = calls.find((c) => c.url.endsWith('/v2/pix/qrcode'))!;
    expect(qr.headers.Authorization).toBe('Bearer tok-1');
    expect(qr.body).toEqual({
      amount: 19.9,
      external_id: 'pay-1',
      payerQuestion: 'Pedido CC-1',
      payer: { name: 'Jogador' },
      postbackUrl: 'https://capitalcityrp.com/api/webhooks/payment?token=x',
    });
  });

  it('consulta a transação e interpreta a resposta embrulhada em requestBody', async () => {
    const { calls, impl } = fakeFetch({
      '/v2/oauth/token': () => ({ json: { access_token: 'tok', expires_in: 1800 } }),
      '/v2/consult-transaction': () => ({
        json: { requestBody: { transactionType: 'RECEIVEPIX', transactionId: 'tx_9', external_id: 'pay-9', amount: 15.0, status: 'PAID' } },
      }),
    });
    const p = new BsPayProvider({ baseUrl: 'https://api.bspay.co', clientId: CLIENT_ID, clientSecret: 's', fetchImpl: impl });
    const tx = await p.getTransaction('tx_9');
    expect(tx).toEqual({ transactionId: 'tx_9', externalId: 'pay-9', amountCents: 1500, status: 'paid', providerStatus: 'PAID' });
    expect(calls.at(-1)!.body).toEqual({ pix_id: 'tx_9', pix_Id: 'tx_9' });
  });

  it('renova o token quando o gateway responde 401', async () => {
    let tokenN = 0;
    let qrN = 0;
    const { impl } = fakeFetch({
      '/v2/oauth/token': () => ({ json: { access_token: `tok-${++tokenN}`, expires_in: 1800 } }),
      '/v2/pix/qrcode': () => (++qrN === 1 ? { status: 401, json: { statusCode: 401, message: 'Erro de autorização' } } : { json: { transactionId: 't', qrcode: 'q' } }),
    });
    const p = new BsPayProvider({ baseUrl: 'https://api.bspay.co', clientId: CLIENT_ID, clientSecret: 's', fetchImpl: impl });
    const r = await p.createPixCharge({ externalId: 'e', amountCents: 100, description: 'd', payer: { name: 'n', email: null }, postbackUrl: 'https://x' });
    expect(r.transactionId).toBe('t');
    expect(tokenN).toBe(2);
  });

  it('erros do gateway não vazam credenciais', async () => {
    const { impl } = fakeFetch({ '/v2/oauth/token': () => ({ status: 401, json: { statusCode: 401, message: 'Credenciais inválidas' } }) });
    const p = new BsPayProvider({ baseUrl: 'https://api.bspay.co', clientId: CLIENT_ID, clientSecret: 'super-secreto', fetchImpl: impl });
    const err = await p.getTransaction('x').catch((e: Error) => e);
    expect(String(err)).toContain('Credenciais inválidas');
    expect(String(err)).not.toContain('super-secreto');
  });

  it('webhook: extrai IDs do formato documentado e só PAID/PENDING são reconhecidos', () => {
    const p = new BsPayProvider({ baseUrl: 'https://api.bspay.co', clientId: CLIENT_ID, clientSecret: 's' });
    expect(
      p.parseWebhook({ requestBody: { transactionType: 'RECEIVEPIX', transactionId: 'abc', external_id: 'ext', amount: 15, status: 'PAID' } }),
    ).toEqual({ transactionId: 'abc', externalId: 'ext', providerStatus: 'PAID' });
    expect(p.parseWebhook({ nada: true })).toBeNull();
    expect(mapBsPayStatus('PAID')).toBe('paid');
    expect(mapBsPayStatus('PENDING')).toBe('pending');
    expect(mapBsPayStatus('QUALQUER')).toBe('unknown');
  });
});
