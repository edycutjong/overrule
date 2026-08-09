/**
 * Ed25519 agent keyring (node:crypto only). COMPLEXITY §2: each agent has an
 * Ed25519 keypair; every ledger entry is signed.
 *
 * FIXTURE MODE: for byte-deterministic demos/tests, keys can be derived from a
 * seed string (sha256 → 32-byte Ed25519 seed wrapped in PKCS#8). These are DEV
 * KEYS for fixtures only — production uses Secret Manager, never derived seeds.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

/** PKCS#8 prefix for a raw 32-byte Ed25519 seed. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface AgentKey {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** SPKI DER hex — what goes into the export manifest for verification. */
  publicKeyHex: string;
}

export type KeyMode = 'FIXTURE_DEV_KEYS' | 'EPHEMERAL_KEYS';

export class Keyring {
  private keys = new Map<string, AgentKey>();
  constructor(public readonly mode: KeyMode) {}

  /** Deterministic dev keyring from seed strings (FIXTURES ONLY). */
  static fixture(agentIds: readonly string[], namespace = 'overrule-dev-key'): Keyring {
    const ring = new Keyring('FIXTURE_DEV_KEYS');
    for (const id of agentIds) {
      const seed = createHash('sha256').update(`${namespace}:${id}`).digest();
      ring.addFromSeed(id, seed);
    }
    return ring;
  }

  /** Fresh random keys (still offline; not reproducible across runs). */
  static ephemeral(agentIds: readonly string[]): Keyring {
    const ring = new Keyring('EPHEMERAL_KEYS');
    for (const id of agentIds) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      ring.add(id, privateKey, publicKey);
    }
    return ring;
  }

  addFromSeed(keyId: string, seed32: Buffer): void {
    if (seed32.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
    const privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]),
      format: 'der',
      type: 'pkcs8',
    });
    this.add(keyId, privateKey, createPublicKey(privateKey));
  }

  private add(keyId: string, privateKey: KeyObject, publicKey: KeyObject): void {
    if (this.keys.has(keyId)) throw new Error(`duplicate key id: ${keyId}`);
    const publicKeyHex = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('hex');
    this.keys.set(keyId, { keyId, privateKey, publicKey, publicKeyHex });
  }

  get(keyId: string): AgentKey {
    const k = this.keys.get(keyId);
    if (!k) throw new Error(`unknown key id: ${keyId}`);
    return k;
  }

  has(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  sign(keyId: string, message: Buffer): string {
    return edSign(null, message, this.get(keyId).privateKey).toString('hex');
  }

  verify(keyId: string, message: Buffer, sigHex: string): boolean {
    return edVerify(null, message, this.get(keyId).publicKey, Buffer.from(sigHex, 'hex'));
  }

  /** keyId → SPKI DER hex, for the export manifest. */
  exportPublic(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, k] of this.keys) out[id] = k.publicKeyHex;
    return out;
  }
}

/** Verify a signature given only the SPKI DER hex public key (no keyring). */
export function verifyWithPublicKeyHex(publicKeyHex: string, message: Buffer, sigHex: string): boolean {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    return edVerify(null, message, publicKey, Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}
