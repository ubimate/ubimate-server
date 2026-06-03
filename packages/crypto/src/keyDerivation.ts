/**
 * Key derivation for the ZK crypto layer.
 *
 * Derives a deterministic Ed25519 keypair from the user's passphrase and email:
 *
 *   seed = Argon2id(password=passphrase, salt=email, m=65536, t=3, p=1, len=32)
 *   keypair = Ed25519(seed)
 *
 * The Ed25519 keypair is also converted to X25519 for asymmetric encryption
 * (content key wrapping, invitation flow) using libsodium's conversion functions.
 */

import _sodium from 'libsodium-wrappers-sumo';

export interface DerivedKeypair {
  /** Ed25519 public key (32 bytes) — stored on the backend */
  ed25519PublicKey: Uint8Array;
  /** Ed25519 public key as base64 string — ready for transport */
  ed25519PublicKeyBase64: string;
  /** Ed25519 private key (64 bytes) — never leaves the client */
  ed25519PrivateKey: Uint8Array;
  /** X25519 public key (32 bytes) — derived from Ed25519, used for key wrapping */
  x25519PublicKey: Uint8Array;
  /** X25519 private key (32 bytes) — derived from Ed25519, used for key unwrapping */
  x25519PrivateKey: Uint8Array;
}

/**
 * Derives the user keypair from their passphrase and email.
 * This is deterministic: same inputs always produce the same keypair.
 */
export async function deriveKeypair(passphrase: string, email: string): Promise<DerivedKeypair> {
  await _sodium.ready;
  const sodium = _sodium;

  const passphraseBytes = sodium.from_string(passphrase);
  // Salt must be exactly crypto_pwhash_SALTBYTES (16 bytes) for libsodium's Argon2id.
  // We derive a 16-byte salt from the email using SHA-256 (take first 16 bytes).
  const emailHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  const salt = new Uint8Array(emailHash).slice(0, sodium.crypto_pwhash_SALTBYTES);

  const seed = sodium.crypto_pwhash(
    32,
    passphraseBytes,
    salt,
    3,       // iterations (opslimit)
    65536 * 1024, // 64 MiB in bytes (memlimit)
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );

  const ed25519Keypair = sodium.crypto_sign_seed_keypair(seed);

  const x25519PublicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Keypair.publicKey);
  const x25519PrivateKey = sodium.crypto_sign_ed25519_sk_to_curve25519(ed25519Keypair.privateKey);

  return {
    ed25519PublicKey: ed25519Keypair.publicKey,
    ed25519PublicKeyBase64: sodium.to_base64(ed25519Keypair.publicKey),
    ed25519PrivateKey: ed25519Keypair.privateKey,
    x25519PublicKey,
    x25519PrivateKey,
  };
}
