import _sodium from 'libsodium-wrappers-sumo';

/**
 * Canonical signed payload for an invitation:
 *   "ubimate_invite:{token}:{normalised_email}:{expires_at}"
 *
 * The domain prefix prevents cross-context signature reuse.
 */
function payloadBytes(token: string, email: string, expiresAt: number): Uint8Array {
  return new TextEncoder().encode(
    `ubimate_invite:${token}:${email.toLowerCase().trim()}:${expiresAt}`,
  );
}

/**
 * Sign an invitation payload with an Ed25519 private key.
 *
 * @param token      - The invitation token (hex string, 32 bytes).
 * @param email      - The invitee's email address.
 * @param expiresAt  - Expiry timestamp in milliseconds since epoch.
 * @param privateKey - Ed25519 private key (64 bytes).
 * @returns          Base64-encoded Ed25519 signature.
 */
export async function signInvitationPayload(
  token: string,
  email: string,
  expiresAt: number,
  privateKey: Uint8Array,
): Promise<string> {
  await _sodium.ready;
  const sig = _sodium.crypto_sign_detached(payloadBytes(token, email, expiresAt), privateKey);
  return _sodium.to_base64(sig);
}

/**
 * Verify an invitation signature.
 *
 * @param token           - The invitation token.
 * @param email           - The invitee's email address.
 * @param expiresAt       - Expiry timestamp in milliseconds since epoch.
 * @param signatureBase64 - Base64-encoded Ed25519 signature to verify.
 * @param senderPublicKey - Sender's Ed25519 public key (32 bytes).
 * @returns               `true` if the signature is valid, `false` otherwise.
 */
export async function verifyInvitationSignature(
  token: string,
  email: string,
  expiresAt: number,
  signatureBase64: string,
  senderPublicKey: Uint8Array,
): Promise<boolean> {
  await _sodium.ready;
  try {
    return _sodium.crypto_sign_verify_detached(
      _sodium.from_base64(signatureBase64),
      payloadBytes(token, email, expiresAt),
      senderPublicKey,
    );
  } catch {
    return false;
  }
}
