/**
 * R40-1: password-reuse protection shared between
 * `/api/auth/password-change` and `/api/auth/password-reset-confirm`.
 *
 * Flow on every rotation:
 *   1. Reject if `newPassword` matches the current password (fast
 *      equality check at the route level).
 *   2. Load `prior_password_hashes jsonb` for the employee.
 *   3. Run `verifySecret(newPassword, hash)` against each entry —
 *      reject with HISTORY_HIT if any match.
 *   4. Before storing the new hash, prepend the OLD hash onto the
 *      history and cap at HISTORY_CAP entries.
 *
 * The cap keeps the row small (~100B × 10 = 1KB) and bounds the
 * verifySecret cost on rotation (PBKDF2 × 10 ≈ 300ms — only paid on
 * the rare rotation action, not on login).
 */
import { verifySecret } from "@/lib/auth/crypto";

export const HISTORY_CAP = 10;

export class PasswordReuseError extends Error {
  readonly status = 400 as const;
  constructor(public readonly message: string = "New password was used recently. Choose a different one.") {
    super(message);
    this.name = "PasswordReuseError";
  }
}

/**
 * Parse the `prior_password_hashes` column into a string[]. Tolerates
 * NULL, legacy missing-column rows, and mis-shaped values by returning
 * an empty array — a missing history is not a security regression;
 * it's either a brand-new account or a pre-R40 row that hasn't yet
 * had a rotation.
 */
export function parseHistory(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // Malformed — treat as empty rather than leaking the parse error.
    }
  }
  return [];
}

/**
 * Verify `candidate` against every entry in the history. Throws
 * PasswordReuseError on the first match.
 *
 * Short-circuits on first match, so best case is O(1). Worst case is
 * HISTORY_CAP PBKDF2 evaluations (~300ms total on Workers).
 */
export async function assertNotReused(candidate: string, history: string[]): Promise<void> {
  for (const oldHash of history) {
    try {
      if (await verifySecret(candidate, oldHash)) {
        throw new PasswordReuseError();
      }
    } catch (err) {
      if (err instanceof PasswordReuseError) throw err;
      // A single mis-shaped hash entry shouldn't kill the whole
      // rotation. Log-and-skip — the new password still has to beat
      // every OTHER entry, so skipping one reduces the check
      // strength but doesn't break security.
      // (No console.error here to keep the helper log-free; callers
      // log the overall outcome.)
    }
  }
}

/**
 * Build the new history array to persist: prepend `oldHash` onto
 * `currentHistory`, dedup (in case a pre-R40 DB has stale duplicates),
 * and truncate to HISTORY_CAP. Returns a plain array ready for
 * JSON.stringify.
 */
export function appendHistory(oldHash: string, currentHistory: string[]): string[] {
  if (!oldHash) return currentHistory.slice(0, HISTORY_CAP);
  const next = [oldHash, ...currentHistory.filter((h) => h !== oldHash)];
  return next.slice(0, HISTORY_CAP);
}
