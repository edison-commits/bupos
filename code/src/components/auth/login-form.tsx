"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { useEffect, useRef } from "react";

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(loginAction, null);
  const router = useRouter();
  const redirected = useRef(false);

  useEffect(() => {
    if (state && "success" in state && !redirected.current) {
      redirected.current = true;
      router.push((state as unknown as { redirect: string }).redirect);
    }
  }, [state, router]);

  return (
    <form action={formAction} className="mt-5 grid gap-4">
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
      {state?.error && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{state.error}</p>
      )}
    </form>
  );
}
