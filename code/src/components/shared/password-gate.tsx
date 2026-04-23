"use client";
/**
 * R41-1: shared step-up / destructive-action confirmation modal.
 *
 * Replaces the interim `window.prompt(...)` pattern used by the
 * gift-card "Disable" button (R36-H5 / R37-H3). Three server routes
 * gate on `requireStepUp` and expect `actorPassword` in the body:
 *   - POST /api/gift-cards {action:"disable", actorPassword}
 *   - DELETE /api/customers {id, actorPassword}
 *   - POST /api/email-receipt?override=true {..., actorPassword}
 *
 * Use via imperative controller so a button handler stays in line
 * rather than sprinkling modal-state plumbing across every caller:
 *
 *   const [promptPassword, gate] = usePasswordGate();
 *   // ...
 *   <button onClick={async () => {
 *     const pwd = await promptPassword({
 *       title: "Disable gift card GC-2026-001?",
 *       description: "This zeroes the customer's balance. Cannot be undone.",
 *       confirmLabel: "Disable",
 *     });
 *     if (!pwd) return; // user cancelled
 *     const r = await doDestructiveThing(pwd);
 *     if (!r.success) setError(r.error);
 *   }}>Disable</button>
 *   {gate}
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface PasswordPromptOptions {
  /** Short noun phrase shown as the modal heading. */
  title: string;
  /** 1-2 sentence description of what the action will do + that it
   *  can't be undone. Rendered in muted text under the heading. */
  description?: string;
  /** Primary button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /**
   * Extra CSS class for the primary button. Red for destructive,
   * emerald for money-movement, etc. Defaults to red (destructive).
   */
  confirmVariant?: "destructive" | "default";
}

type Resolver = (password: string | null) => void;

interface State {
  opts: PasswordPromptOptions;
  resolve: Resolver;
}

/**
 * Hook that returns `[promptPassword, gate]` — the controller
 * function and the JSX element to render in the component tree.
 *
 * The gate renders nothing when no prompt is active, so it's safe
 * to mount at a root-ish level of each page.
 */
export function usePasswordGate(): [
  (opts: PasswordPromptOptions) => Promise<string | null>,
  React.ReactElement,
] {
  const [state, setState] = useState<State | null>(null);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the password input when the modal opens.
  useEffect(() => {
    if (state) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    setPassword("");
    setErrorMsg(null);
    setSubmitting(false);
  }, [state]);

  // ESC closes the modal as "cancel"; Enter submits the form; Tab /
  // Shift+Tab cycles through the modal's focusable elements without
  // escaping to the underlying page.
  //
  // R42-L: focus trap. Prior shape left Tab free to move into the
  // page behind the modal — a user (or a malicious browser extension)
  // could interact with background content while a step-up re-auth
  // was pending. Trapping keeps keyboard focus within the modal for
  // its entire lifecycle.
  const modalRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        state.resolve(null);
        setState(null);
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !modalRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !modalRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  const promptPassword = useCallback(
    (opts: PasswordPromptOptions) => {
      return new Promise<string | null>((resolve) => {
        setState({ opts, resolve });
      });
    },
    [],
  );

  const handleConfirm = () => {
    if (!state) return;
    const pwd = password.trim();
    if (!pwd) {
      setErrorMsg("Password is required.");
      return;
    }
    setSubmitting(true);
    state.resolve(pwd);
    setState(null);
  };

  const handleCancel = () => {
    if (!state) return;
    state.resolve(null);
    setState(null);
  };

  const gate = state ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-gate-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm"
      onClick={(e) => {
        // Clicks on the overlay (but not the inner card) cancel.
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div ref={modalRef} className="mx-4 w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-2xl">
        <h2 id="password-gate-title" className="text-lg font-semibold text-slate-900">
          {state.opts.title}
        </h2>
        {state.opts.description && (
          <p className="mt-2 text-sm text-slate-600">{state.opts.description}</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirm();
          }}
          className="mt-4"
        >
          <label className="block text-sm font-medium text-slate-700">
            Your password
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errorMsg) setErrorMsg(null);
              }}
              autoComplete="current-password"
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
              required
            />
          </label>
          {errorMsg && <p className="mt-2 text-sm text-red-600">{errorMsg}</p>}
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={
                state.opts.confirmVariant === "default"
                  ? "rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  : "rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
              }
            >
              {state.opts.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>
  ) : (
    <></>
  );

  return [promptPassword, gate];
}
