import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Password hashing.
 *
 * Uses scrypt from Node's standard library rather than adding bcrypt or argon2. scrypt
 * is memory-hard by design — the cost parameter forces an attacker to spend RAM as well
 * as CPU per guess, which is what blunts GPU and ASIC cracking. It is a current OWASP
 * password-storage recommendation, and taking it from the platform avoids pulling a
 * native module into the Docker build.
 *
 * Stored format: `scrypt$N$r$p$<salt-hex>$<hash-hex>`
 * The parameters travel with the hash, so raising the cost later does not invalidate
 * existing passwords — old hashes keep verifying against the parameters they were made
 * with, and `needsRehash` reports which ones should be upgraded on next sign-in.
 */

/**
 * Hand-rolled rather than `promisify`d: promisify collapses to the 3-argument overload
 * and drops the options parameter, which is where the cost factors live.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * ~64MB of memory per hash (128 * r * N bytes). Comfortably above the OWASP floor while
 * staying fast enough for an interactive sign-in on modest hardware.
 */
const COST = 16_384; // N
const BLOCK_SIZE = 8; // r
const PARALLELIZATION = 1; // p
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const ALGORITHM = "scrypt";

/** scrypt's internal memory guard must be raised to allow N=16384 with r=8. */
const MAX_MEMORY = 128 * BLOCK_SIZE * COST * 2;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Length bounds only. Composition rules (a digit, a symbol, mixed case) push people
 * toward short predictable passwords and password reuse; length is the property that
 * actually correlates with strength. The upper bound exists so a megabyte-long input
 * cannot be used to burn CPU.
 */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELIZATION,
    maxmem: MAX_MEMORY,
  });

  return [
    ALGORITHM,
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must fail the
 * login, not crash the auth route. Comparison is constant-time so response latency
 * cannot be used to recover the hash byte by byte.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6) return false;

  const [algorithm, costRaw, blockSizeRaw, parallelizationRaw, saltHex, hashHex] = parts;
  if (algorithm !== ALGORITHM) return false;

  const cost = Number.parseInt(costRaw, 10);
  const blockSize = Number.parseInt(blockSizeRaw, 10);
  const parallelization = Number.parseInt(parallelizationRaw, 10);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return false;
  }

  let expected: Buffer;
  let salt: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scrypt(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 128 * blockSize * cost * 2,
    });

    // Lengths are equal by construction here, but timingSafeEqual throws if they differ.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return true;
  return Number.parseInt(parts[1], 10) < COST;
}
