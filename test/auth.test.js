// The sign-in check, with a made-up signing key standing in for Google's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { makeVerifier } from '../src/auth.js';

const PROJECT = 'rumblekarts';

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = Object.assign(await exportJWK(publicKey), { kid: 'k1', alg: 'RS256' });
  const verify = makeVerifier({ projectId: PROJECT, keys: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims, opts = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss || 'https://securetoken.google.com/' + PROJECT)
    .setAudience(opts.aud || PROJECT)
    .setSubject(opts.sub || 'uid123')
    .setIssuedAt()
    .setExpirationTime(opts.exp || '1h')
    .sign(privateKey);
  return { verify, sign };
}

test('a real Firebase-style token is accepted and gives the user id', async () => {
  const { verify, sign } = await setup();
  assert.deepEqual(await verify(await sign({})), { uid: 'uid123' });
});

test('tokens for another project, expired ones, and junk are refused', async () => {
  const { verify, sign } = await setup();
  await assert.rejects(verify(await sign({}, { aud: 'someone-else' })));
  await assert.rejects(verify(await sign({}, { iss: 'https://securetoken.google.com/someone-else' })));
  await assert.rejects(verify(await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })));
  await assert.rejects(verify('not-a-token'));
  await assert.rejects(verify(undefined));
});
