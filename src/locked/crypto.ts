/**
 * Password encryption for locked pages, in Web Crypto only, so the same code runs in the browser
 * (to open a page) and in Node (scripts/lock/lock.mjs, to seal one).
 *
 * Key: PBKDF2-SHA256 over the password with a random 16-byte salt. Cipher: AES-256-GCM with a
 * random 12-byte IV. A wrong password fails GCM's tag check, so decrypt throws.
 */

export interface Sealed {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  /** Base64. */
  salt: string;
  /** Base64. */
  iv: string;
  /** Base64: the ciphertext with GCM's 16-byte tag at the end. */
  ct: string;
}

export const ITERATIONS = 600_000;

const subtle = () => globalThis.crypto.subtle;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Seal a text with a password. A fresh salt and IV every call. */
export async function seal(text: string, password: string, iter = ITERATIONS): Promise<Sealed> {
  if (!password) throw new Error('No password given');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iter);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter, salt: toBase64(salt), iv: toBase64(iv), ct: toBase64(ct) };
}

/** Open a sealed text. Throws on a wrong password, a damaged file or an unknown format. */
export async function open(sealed: Sealed, password: string): Promise<string> {
  if (!sealed || sealed.v !== 1 || sealed.kdf !== 'PBKDF2-SHA256' || !(sealed.iter > 0)) throw new Error('Unknown locked file format');
  const key = await deriveKey(password, fromBase64(sealed.salt), sealed.iter);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.ct));
  return new TextDecoder().decode(pt);
}
