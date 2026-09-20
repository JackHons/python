import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const KEY_LENGTH = 64;

export function hashPassword(password: string) {
  if (password.length < 8 || password.length > 256) {
    throw new Error("Password must contain 8 to 256 characters");
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELIZATION, Buffer.from(salt).toString("base64url"), Buffer.from(derived).toString("base64url")].join("$");
}

export function verifyPassword(password: string, encoded: string) {
  const [algorithm, nValue, rValue, pValue, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !nValue || !rValue || !pValue || !saltValue || !hashValue) return false;
  try {
    const expected = Buffer.from(hashValue, "base64url");
    const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length, {
      N: Number(nValue),
      r: Number(rValue),
      p: Number(pValue),
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(bytes = 32) {
  return Buffer.from(randomBytes(bytes)).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
