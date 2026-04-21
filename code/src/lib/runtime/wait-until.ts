/**
 * R22-M-3: safe wrapper around Cloudflare's `ctx.waitUntil()` for
 * post-response async work.
 *
 * On Workers, returning a `NextResponse` ends the request scope. Any
 * Promise not registered with `waitUntil` is cancelled by the
 * `no_handle_cross_request_promise_resolution` compat flag — the
 * in-flight DELETE / INSERT / audit write silently vanishes.
 *
 * In non-Workers runtimes (Node dev, vitest, plain Next.js) there is
 * no `ctx.waitUntil`, so we fall back to awaiting the promise before
 * the handler returns. A ~30ms tail latency in dev is acceptable; the
 * alternative is test flakiness from unobserved promise rejections.
 *
 * Usage:
 *   const p = pool.query(...).catch(logErr);
 *   await waitUntilOrAwait(p);   // runs in background on Workers, awaits elsewhere
 *   return NextResponse.redirect(...);
 *
 * R23-H-1: prior shape extracted `ctx.waitUntil` into a local
 * `wu` variable and then called `wu(promise)`. Cloudflare's
 * ExecutionContext methods are C++ host bindings that require
 * `this === ctx`; detached invocation throws "Illegal invocation".
 * The catch silently swallowed the throw and fell through to the
 * synchronous await — defeating the whole point of the helper while
 * spamming prod logs with error warnings on every call. Fix: invoke
 * as a method (`execCtx.waitUntil(promise)`) so the binding is
 * preserved. OpenNext's own wrappers do `ctx.waitUntil.bind(ctx)`
 * for the same reason.
 *
 * R23-M-1: module-level one-shot flags gate the dev/test warnings so
 * the fallback path doesn't emit a warn per call (next.config.ts
 * doesn't call initOpenNextCloudflareForDev, so every dev call would
 * otherwise log 400+ chars of OpenNext boilerplate).
 *
 * R23-L-2: module-scope cached import promise so cold-start only
 * resolves `@opennextjs/cloudflare` once per isolate.
 */

import { safeErr } from "@/lib/logging/safe-err";

type CloudflareModule = typeof import("@opennextjs/cloudflare");

// R23-L-2: cache the module resolution. The Promise itself memoizes
// the result; rejection is captured so subsequent calls don't retry
// indefinitely against a broken module graph.
let _cfModulePromise: Promise<CloudflareModule | null> | null = null;
function loadCloudflareModule(): Promise<CloudflareModule | null> {
  if (_cfModulePromise) return _cfModulePromise;
  _cfModulePromise = import("@opennextjs/cloudflare")
    .then((mod) => mod)
    .catch(() => null);
  return _cfModulePromise;
}

// R23-M-1: one-shot warn flags so dev/test logs aren't spammed on
// every single call. If the runtime legitimately lacks waitUntil, we
// log ONE notice per isolate and fall back silently thereafter.
let _warnedNoOpenNext = false;
let _warnedNoWaitUntil = false;

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export async function waitUntilOrAwait<T>(promise: Promise<T>): Promise<void> {
  let scheduledInBackground = false;
  try {
    const mod = await loadCloudflareModule();
    if (!mod) {
      // Module not available at all (non-Workers env). Fall through.
      if (!_warnedNoOpenNext) {
        _warnedNoOpenNext = true;
        console.info("[waitUntilOrAwait] @opennextjs/cloudflare unavailable; using synchronous await fallback (dev/test).");
      }
    } else {
      const ctx = await mod.getCloudflareContext({ async: true }).catch(() => null);
      // R24-L-5: `@opennextjs/cloudflare` contract (verified against
      // v1.17.3) always nests ExecutionContext under `ctx.ctx`. The
      // prior "flattened" fallback branch never matched a real shape
      // and was dead code. If a future OpenNext version flattens the
      // context, re-add the fallback then.
      const execCtx: ExecutionContextLike | undefined =
        (ctx as { ctx?: ExecutionContextLike } | null)?.ctx;
      if (execCtx && typeof execCtx.waitUntil === "function") {
        // Method-form invocation preserves `this` binding. R23-H-1.
        execCtx.waitUntil(promise);
        scheduledInBackground = true;
      } else if (!_warnedNoWaitUntil) {
        _warnedNoWaitUntil = true;
        console.info("[waitUntilOrAwait] ExecutionContext.waitUntil unavailable; using synchronous await fallback.");
      }
    }
  } catch (err) {
    // getCloudflareContext threw unexpectedly — log once, fall
    // through to synchronous await.
    if (!_warnedNoOpenNext) {
      _warnedNoOpenNext = true;
      console.warn("[waitUntilOrAwait] cloudflare context lookup threw:", safeErr(err));
    }
  }
  if (scheduledInBackground) return;
  // Not on Workers (or waitUntil unavailable) — await before returning
  // so the promise settles.
  try {
    await promise;
  } catch {
    // Caller attached a .catch already; this swallow is belt-and-suspenders.
  }
}

