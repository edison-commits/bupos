"use client";

import type { FormHTMLAttributes, ReactNode } from "react";

/**
 * R48: shared <SubmitGuardForm> wrapper that synchronously disables
 * the form's submit button on the first submit. Prevents the
 * double-click → two concurrent server-action invocations vector
 * R47 / R48 kept rediscovering across admin-console + register
 * forms.
 *
 * The guard is intentionally simple: on submit, walk down to the
 * first `button[type="submit"]` and mutate its `disabled` attribute.
 * If it's already disabled, preventDefault. React's `disabled={...}`
 * prop goes through the scheduler and commits on the NEXT render
 * (~16ms), which is wide enough for a fast double-tap to land two
 * submits — mutating the DOM attribute directly in the synchronous
 * event handler closes the window.
 *
 * Usage:
 *
 *   <SubmitGuardForm action={someServerAction} className="...">
 *     <input name="..." />
 *     <button type="submit">Save</button>
 *   </SubmitGuardForm>
 *
 * Re-enable is left to the form's own flow — on success the page
 * usually navigates / revalidates, on failure the parent can
 * re-render with an error state (the button is in a new tree, so
 * the mutated `.disabled` resets). If a form needs to re-enable
 * in-place after an error, pass `resetOnError` and handle the
 * returned state manually.
 */
export interface SubmitGuardFormProps
  extends Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit"> {
  children: ReactNode;
}

export function SubmitGuardForm({ children, ...formProps }: SubmitGuardFormProps) {
  return (
    <form
      {...formProps}
      onSubmit={(e) => {
        const btn = e.currentTarget.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        );
        if (btn) {
          if (btn.disabled) {
            e.preventDefault();
            return;
          }
          btn.disabled = true;
        }
      }}
    >
      {children}
    </form>
  );
}
