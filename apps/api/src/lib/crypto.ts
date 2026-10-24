import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

// AES-256-GCM with a fresh random 96-bit IV per value. GCM is authenticated: a
// tampered or truncated blob — or one sealed with a DIFFERENT key — fails to decrypt rather than
// yielding garbage. That property is what makes key rotation safe: "try the keys in order" can never
// return a wrong plaintext, only the right one or an error.
// Format: "v1.<iv>.<tag>.<ciphertext>" (base64url).

const VERSION = "v1";

export function encryptWithKey(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptWithKey(blob: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = blob.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Unrecognized encrypted value format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/** One key that encrypts, plus any number of decrypt-only keys for values not yet rotated. */
export interface Keyring {
  encrypt(plain: string): string;
  decrypt(blob: string): string;
  /** True if the CURRENT key opens this blob, i.e. it needs no rotation. */
  isCurrent(blob: string): boolean;
}

export function createKeyring(current: Buffer, extra: Buffer[] = []): Keyring {
  const all = [current, ...extra];
  return {
    encrypt: (plain) => encryptWithKey(plain, current),
    decrypt(blob) {
      for (const key of all) {
        try {
          return decryptWithKey(blob, key);
        } catch {
          // wrong key (GCM tag mismatch) — try the next one
        }
      }
      // Same message whether the format was bad or no key matched: never hint which.
      throw new Error("Could not decrypt value with any configured key");
    },
    isCurrent(blob) {
      try {
        decryptWithKey(blob, current);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function parseKeyList(csv: string | undefined): Buffer[] {
  return (csv ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => Buffer.from(k, "base64"));
}

export const keyring = createKeyring(Buffer.from(config.TOKEN_ENCRYPTION_KEY, "base64"), parseKeyList(config.TOKEN_ENCRYPTION_KEYS_EXTRA));

export const encryptSecret = (plain: string) => keyring.encrypt(plain);
export const decryptSecret = (blob: string) => keyring.decrypt(blob);
