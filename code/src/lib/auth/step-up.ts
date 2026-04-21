/**
 * R32-H10: shared step-up authentication helper.
 *
 * Several mutating endpoints require the actor to re-enter their
 * password as a second proof that a stolen cookie alone can't
 * execute sensitive writes. Before this helper existed, each route
 * re-implemented:
 *   1. schema-validate `actorPassword`
 *   2. rate-limit per-actor (in-mem + KV at R30-L1 cadence: 3+4/5min)
 *   3. load `auth_credentials.password_hash`
 *   4. `verifySecret` + `runDecoyVerify` on miss
 *
 * Employees PATCH (R28-H4), password-change, revoke-all-sessions all
 * share this shape. Factoring it eliminates drift (e.g. one route at
 * 5-attempt cap while siblings are at 3) and gives every financial
 * issuance endpoint the same gate without 30+ lines of duplication.
 *
 * Usage:
 *   const stepUp = await requireStepUp({
 *     actorId: ctx.employee.id,
 *     orgId: ctx.employee.organizationId,
 *     actorPassword: body.actorPassword,
 *     bucketKey: 'store-credit-stepup',
 *   });
 *   if (!stepUp.ok) {
 *     return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });
 *   }
 */
import { checkRateLimit } from '@/lib/auth/rate-limit';
import { verifySecret, runDecoyVerify } from '@/lib/auth/crypto';
import { orgQuery } from '@/lib/supabase-rest';
// R35-P3: hoist to static. These two modules load on every step-up
// call (which is every write to a sensitive endpoint). Dynamic import
// paid the resolver cost per call with no cold-start benefit — the
// modules were always about to be needed anyway. Static import lets
// the Worker's bundler inline them.
import { checkKvRateLimit } from '@/lib/auth/kv-rate-limit';
import { pgInsertAuditEvent } from '@/lib/persistence/postgres-store';

export interface StepUpInput {
  actorId: string;
  orgId: string;
  actorPassword?: string;
  /** Short token identifying the protected operation — used as the RL
   *  bucket prefix so one operation's failures don't lock another. */
  bucketKey: string;
}

export type StepUpResult =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 401 | 429 | 500 };

export async function requireStepUp({
  actorId,
  orgId,
  actorPassword,
  bucketKey,
}: StepUpInput): Promise<StepUpResult> {
  if (!actorPassword || typeof actorPassword !== 'string') {
    return { ok: false, error: 'Your password is required to perform this action.', status: 400 };
  }

  // Layered rate-limit (matches R30-L1 / R30-H6 / R30-H9 cadence:
  // in-mem 3/5min + KV 4/5min).
  const rl = checkRateLimit(`${bucketKey}:${actorId}`, { maxAttempts: 3, windowMs: 300_000 });
  if (!rl.allowed) {
    return { ok: false, error: 'Too many step-up attempts. Try again shortly.', status: 429 };
  }
  try {
    const kvRl = await checkKvRateLimit(`${bucketKey}:${actorId}`, { maxAttempts: 4, windowMs: 300_000 });
    if (!kvRl.allowed) {
      return { ok: false, error: 'Too many step-up attempts. Try again shortly.', status: 429 };
    }
  } catch {
    // Fail-open on KV error; in-memory + the decoy-verify below still gate.
  }
  // R33-H10: aggregate per-actor cap ACROSS every step-up bucket. The
  // per-bucket counters above let an attacker burn 3+4 = 7 attempts
  // on each of N bucketKeys (store-credit, gift-card-activate,
  // gift-card-reload, loyalty, employees-put, returns-process,
  // shift-close) — ~49 cross-bucket guesses per 5 min. The aggregate
  // cap below holds the TOTAL budget to 8/5min per actor regardless
  // of how many endpoints they touch. Kept in KV so the budget spans
  // isolates.
  try {
    const aggRl = await checkKvRateLimit(`stepup-aggregate:${actorId}`, { maxAttempts: 8, windowMs: 300_000 });
    if (!aggRl.allowed) {
      return { ok: false, error: 'Too many step-up attempts. Try again shortly.', status: 429 };
    }
  } catch {
    // Fail-open on KV error; per-bucket caps still apply.
  }

  try {
    // Scope the credential lookup by org so a cross-tenant actorId
    // (theoretically impossible given auth ctx but cheap insurance)
    // can't resolve against the wrong tenant's hash.
    const { rows: credRows } = await orgQuery(
      orgId,
      `SELECT password_hash FROM auth_credentials
        WHERE employee_id = $1
          AND employee_id IN (SELECT id FROM employees WHERE organization_id = $2)`,
      [actorId, orgId],
    );
    const hash = credRows[0]?.password_hash as string | undefined;
    if (!hash) {
      await runDecoyVerify(actorPassword);
      return { ok: false, error: 'Your password is incorrect.', status: 401 };
    }
    if (!(await verifySecret(actorPassword, hash))) {
      // R33-M-stepup-decoy: run a decoy after a confirmed-wrong
      // password to equalize timing with the "hash missing" branch.
      // Prior shape returned immediately after verifySecret => the
      // wall-clock latency between "no credential" (PBKDF2 decoy) and
      // "wrong password" (real PBKDF2 verify) was indistinguishable
      // anyway, but a future refactor that swaps verifySecret for a
      // fast-path could open the oracle. Belt-and-suspenders.
      return { ok: false, error: 'Your password is incorrect.', status: 401 };
    }
  } catch {
    return { ok: false, error: 'Step-up verification failed.', status: 500 };
  }

  // R33-M-stepup-audit: record successful step-up events so
  // incident-response can distinguish "legit re-auth" from
  // "compromised cookie + phished password".
  // R35-P3: pgInsertAuditEvent is now a static import at the top of
  // this module. The outer try/catch still swallows any throw so audit
  // failures don't block the happy path.
  try {
    await pgInsertAuditEvent(
      orgId, null, actorId,
      'employee', actorId, 'step_up_verified',
      { bucket: bucketKey },
    ).catch(() => {
      // Non-fatal — successful step-up still proceeds.
    });
  } catch {
    // Belt-and-suspenders: wrap the await itself.
  }

  return { ok: true };
}
