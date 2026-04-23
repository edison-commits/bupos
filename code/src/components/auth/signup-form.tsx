"use client";

import { useActionState } from "react";
import { signupAction } from "@/app/actions/auth";

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signupAction, null);

  return (
    <form action={formAction} className="grid gap-4">
      <label className="grid gap-1.5 text-sm font-medium text-zinc-700">
        <span>Store name</span>
        <input
          name="storeName"
          type="text"
          required
          placeholder="Basic Uniform"
          className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1.5 text-sm font-medium text-zinc-700">
          <span>First name</span>
          <input
            name="firstName"
            type="text"
            required
            placeholder="John"
            className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-zinc-700">
          <span>Last name</span>
          <input
            name="lastName"
            type="text"
            required
            placeholder="Doe"
            className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
          />
        </label>
      </div>

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
          minLength={12}
          autoComplete="new-password"
          placeholder="At least 12 characters"
          className="rounded-xl border border-zinc-300 bg-white px-4 py-3 text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
        />
      </label>

      <button
        type="submit"
        disabled={isPending}
        className="mt-1 rounded-xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-teal-500 disabled:opacity-50"
      >
        {isPending ? "Creating store…" : "Create store"}
      </button>

      {state?.error && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{state.error}</p>
      )}
    </form>
  );
}
