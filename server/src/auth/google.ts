import { OAuth2Client } from 'google-auth-library';
import { unauthorized } from '../lib/errors.js';

export interface GoogleProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleProfile>;

/** Valida o ID token do Google no servidor (assinatura, emissor, expiração e audience = nossos Client IDs). */
export function createGoogleVerifier(clientIds: string[]): GoogleVerifier {
  const client = new OAuth2Client();
  return async (idToken: string) => {
    if (clientIds.length === 0) throw unauthorized('Login com Google não configurado.');
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientIds });
      const p = ticket.getPayload();
      if (!p?.sub) throw new Error('payload vazio');
      return {
        sub: p.sub,
        email: p.email ?? null,
        emailVerified: p.email_verified === true,
        name: p.name ?? p.given_name ?? '',
        picture: p.picture ?? null,
      };
    } catch {
      throw unauthorized('Não foi possível validar o login com Google.');
    }
  };
}
