// Checks the Firebase sign-in token every player already has (anonymous or Google), so the relay knows who is who
// without a second login. Tokens are signed by Google; we check the signature against Google's published keys.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_KEYS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export function makeVerifier({ projectId, mode = 'firebase', keys } = {}) {
  if (mode === 'off') {
    // Local testing only: the "token" is taken as the user id. index.js refuses this unless ALLOW_INSECURE_AUTH=1.
    return async token => {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(token)) throw new Error('Bad test token');
      return { uid: token };
    };
  }
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not set');
  const jwks = keys || createRemoteJWKSet(new URL(GOOGLE_KEYS), { cacheMaxAge: 6 * 3600 * 1000 });
  return async token => {
    if (typeof token !== 'string' || token.length > 4096) throw new Error('Missing sign-in token');
    const { payload } = await jwtVerify(token, jwks, {
      issuer: 'https://securetoken.google.com/' + projectId,
      audience: projectId,
      algorithms: ['RS256'],
    });
    if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) throw new Error('Bad sign-in token');
    return { uid: payload.sub };
  };
}
