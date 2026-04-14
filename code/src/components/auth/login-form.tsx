"use client";

import { useState } from "react";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsPending(true);

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        body: formData,
        redirect: "manual",
        credentials: "same-origin",
      });

      // With redirect: "manual", a 303 returns as an opaque redirect (type "opaqueredirect")
      // The Set-Cookie header is applied to the browser cookie jar in this case.
      // status is 0 for opaque redirects, or 303 if readable.
      if (res.status === 303 || res.status === 0 || res.type === "opaqueredirect" || res.redirected) {
        window.location.href = "/admin";
        return;
      }

      // Error response
      const data = await res.json().catch(() => null) as { error?: string } | null;
      setError(data?.error ?? "Login failed. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setIsPending(false);
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
