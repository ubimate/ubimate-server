// Copyright (c) 2026 Ubimate. Licensed under the Elastic License 2.0 (ELv2).
// See LICENSE in the project root for details.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface IssuedChallenge {
  algorithm: string;
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

/** Brute-force the PoW the way a client would (Node SHA-256 of `salt + n`). */
function solveChallenge(ch: IssuedChallenge): string {
  for (let n = 0; n <= ch.maxnumber; n++) {
    const hex = createHash('sha256').update(ch.salt + n).digest('hex');
    if (hex === ch.challenge) {
      return Buffer.from(JSON.stringify({
        algorithm: ch.algorithm,
        challenge: ch.challenge,
        number: n,
        salt: ch.salt,
        signature: ch.signature,
        took: 1,
      })).toString('base64');
    }
  }
  throw new Error('no PoW solution found within maxnumber');
}

describe('captcha module', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ALTCHA_MAX_NUMBER = '2000';
  });

  afterEach(() => {
    delete process.env.ALTCHA_HMAC_KEY;
    delete process.env.ALTCHA_MAX_NUMBER;
    vi.resetModules();
  });

  it('reports enforcement off when ALTCHA_HMAC_KEY is unset, and accepts any payload', async () => {
    delete process.env.ALTCHA_HMAC_KEY;
    const { isCaptchaEnforced, verifyCaptchaPayload } = await import('../lib/captcha');
    expect(isCaptchaEnforced()).toBe(false);
    expect(await verifyCaptchaPayload(undefined)).toEqual({ ok: true });
    expect(await verifyCaptchaPayload('anything')).toEqual({ ok: true });
  });

  it('issues a challenge and verifies a correctly solved payload', async () => {
    process.env.ALTCHA_HMAC_KEY = 'unit-test-captcha-key';
    const { isCaptchaEnforced, issueCaptchaChallenge, verifyCaptchaPayload } = await import('../lib/captcha');
    expect(isCaptchaEnforced()).toBe(true);

    const challenge = await issueCaptchaChallenge();
    const payload = solveChallenge(challenge);
    expect(await verifyCaptchaPayload(payload)).toEqual({ ok: true });
  });

  it('rejects a missing payload with 400 and an invalid payload with 403', async () => {
    process.env.ALTCHA_HMAC_KEY = 'unit-test-captcha-key';
    const { verifyCaptchaPayload } = await import('../lib/captcha');

    expect(await verifyCaptchaPayload(undefined)).toEqual({ ok: false, status: 400, error: 'CAPTCHA solution required' });
    expect(await verifyCaptchaPayload('not-a-valid-payload')).toEqual({ ok: false, status: 403, error: 'CAPTCHA solution invalid or expired' });
  });

  it('rejects a payload solved against a different key', async () => {
    // Issue with one key…
    process.env.ALTCHA_HMAC_KEY = 'key-a';
    const issueMod = await import('../lib/captcha');
    const challenge = await issueMod.issueCaptchaChallenge();
    const payload = solveChallenge(challenge);

    // …then verify under a different key (signature won't match).
    vi.resetModules();
    process.env.ALTCHA_HMAC_KEY = 'key-b';
    const verifyMod = await import('../lib/captcha');
    expect(await verifyMod.verifyCaptchaPayload(payload)).toEqual({ ok: false, status: 403, error: 'CAPTCHA solution invalid or expired' });
  });
});
