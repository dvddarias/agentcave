import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Sortable unique id (ULID-like): 10 chars of time + 16 chars of randomness. */
export function newId(prefix: string): string {
  let time = Date.now();
  let t = "";
  for (let i = 0; i < 10; i++) {
    t = ALPHABET[time % 32] + t;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let r = "";
  for (const b of bytes) r += ALPHABET[b % 32];
  return `${prefix}_${t}${r}`;
}

export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
