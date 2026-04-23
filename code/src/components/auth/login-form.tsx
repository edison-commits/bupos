"use client";

import { useState } from "react";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // R44-LOW: synchronously disable the submit button to block
    // double-submit. `setIsPending(true)` goes through React's
    // scheduler and doesn't commit the `disabled` attribute until
    // the next render (~16ms window), so a fast double-click can
    // fire two concurrent POSTs, each burning a rate-limit attempt.
    // Mutating the DOM attribute directly closes that window.
    const form = e.currentTarget;
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submitBtn) {
      if (submitBtn.disabled) return;
      submitBtn.disabled = true;
    }
    setError(null);
    setIsPending(true);

    const formData = new FormData(form);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });

      const data = await res.json().catch(() => null) as { success?: boolean; redirect?: string; sessionId?: string; error?: string } | null;

      if (res.ok && data?.success) {
        // API route sets HttpOnly cookie via Set-Cookie header
        // Full page reload to send cookie with the request
        window.location.href = data.redirect || "/admin";
        return;
      }

      setError(data?.error ?? "Login failed. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsPending(false);
      // Re-enable the button for retry after error.
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-5 grid gap-4">
      <label className="grid gap-1.5 text-sm font-medium text-zinc-700">
        <span>Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@yourstore.com"
          className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium text-zinc-700">
        <span>Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
        />
      </label>
      <button
        type="submit"
        disabled={isPending}
        className="mt-1 rounded-xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-500 disabled:opacity-50"
      >
        {isPending ? "Signing in…" : "Sign in"}
      </button>
      {error && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}
    </form>
  );
}
