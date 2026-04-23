"use client";

import type { FormHTMLAttributes, ReactNode } from "react";
import { usePasswordGate, type PasswordPromptOptions } from "@/components/shared/password-gate";
import { safeErr } from "@/lib/logging/safe-err";

/**
 * R50/R51: client wrapper that combines the R48 double-submit guard
 * (SubmitGuardForm) with the R41-1 step-up <PasswordGate>. On submit:
 *
 *   1. Synchronously disable the submit button (R48 pattern).
 *   2. Optionally evaluate `gateCondition(formData, form)` — if it
 *      returns `false`, skip the password prompt and submit directly.
 *      Defaults to always gating when `gateCondition` is omitted.
 *   3. Open the <PasswordGate> modal; if cancelled, re-enable the
 *      button and bail.
 *   4. On confirm, append `actorPassword` to the FormData and invoke
 *      the server action with that FormData (server action handles
 *      revalidate/redirect).
 *
 * Server actions in /src/app/admin/actions.ts that gate on
 * `requireStepUp` read `actorPassword` from FormData and fail closed
 * if empty. Wiring this component in place of `<SubmitGuardForm>` /
 * `<form action={...}>` is the UI half of the R49 step-up plumbing
 * (R50 audit noted the backend gates were shipped without the UI
 * prompt on four admin-console sites).
 *
 * Usage:
 *
 *   <PasswordGatedForm
 *     action={createEmployeeAction}
 *     prompt={{
 *       title: "Create new employee?",
 *       description: "Confirm with your password — provisioning a new user is a privilege-elevation action.",
 *       confirmLabel: "Create employee",
 *       confirmVariant: "default",
 *     }}
 *     className="grid gap-3 md:grid-cols-2"
 *   >
 *     <Input name="firstName" ... />
 *     ...
 *     <button type="submit">Create employee</button>
 *   </PasswordGatedForm>
 *
 * For conditional gating (e.g. editVariantAction only on price/cost
 * change), pass `gateCondition`:
 *
 *   <PasswordGatedForm
 *     action={editVariantAction}
 *     prompt={...}
 *     gateCondition={(_fd, form) => {
 *       const priceInp = form.querySelector<HTMLInputElement>('input[name="price"]');
 *       const costInp  = form.querySelector<HTMLInputElement>('input[name="cost"]');
 *       const priceChanged = priceInp ? priceInp.value !== priceInp.defaultValue : false;
 *       const costChanged  = costInp  ? costInp.value  !== costInp.defaultValue  : false;
 *       return priceChanged || costChanged;
 *     }}
 *   >
 *     ...
 *   </PasswordGatedForm>
 *
 * Design notes:
 * - The DOM-attribute mutation on the submit button (instead of
 *   React-state `disabled`) closes the ~16ms fast-double-tap window
 *   that React's scheduler creates (same rationale as R48).
 * - If the server action throws or redirects, the component tree
 *   typically unmounts/re-renders, which naturally resets the button.
 *   On cancellation from the modal, we manually re-enable the button
 *   so a second attempt works without a page refresh.
 */
export interface PasswordGatedFormProps
  extends Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit" | "action"> {
  /** Server action that accepts FormData (includes `actorPassword`). */
  action: (formData: FormData) => void | Promise<void>;
  /** Modal copy shown to the user before submitting. */
  prompt: PasswordPromptOptions;
  /**
   * Optional predicate: if it returns `false`, the submit skips the
   * password prompt entirely. Useful for edit forms where step-up is
   * only required on specific field changes (e.g. variant price/cost
   * change in `editVariantAction`).
   */
  gateCondition?: (formData: FormData, form: HTMLFormElement) => boolean;
  children: ReactNode;
}

export function PasswordGatedForm({
  action,
  prompt,
  gateCondition,
  children,
  ...formProps
}: PasswordGatedFormProps) {
  const [promptPassword, gate] = usePasswordGate();

  return (
    <>
      <form
        {...formProps}
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          // R52-P: re-query the submit button from the form element
          // after each await, not once at submit-time. The initial
          // query captures a Node reference; if React reconciles the
          // tree during the await (parent state change, router
          // transition), that Node may be detached — re-enabling
          // `.disabled = false` on a detached Node is a no-op and
          // leaves the actual current button stuck. Re-querying via
          // `form.querySelector(...)` at each state-change point
          // always hits the live DOM.
          const findBtn = () =>
            form.querySelector<HTMLButtonElement>('button[type="submit"]');
          const initialBtn = findBtn();
          // R48: close fast-double-tap window.
          if (initialBtn) {
            if (initialBtn.disabled) return;
            initialBtn.disabled = true;
          }

          const run = async () => {
            const fd = new FormData(form);
            // R54-Framework-2: wrap gateCondition in try/catch so a
            // buggy predicate (e.g. the form.querySelector call
            // throws on a stale-ref shape) can't leave the submit
            // button permanently disabled. Default to gating on
            // exception — safer to over-prompt than to skip a
            // legitimately required step-up prompt.
            let shouldGate = true;
            if (gateCondition) {
              try {
                shouldGate = gateCondition(fd, form);
              } catch (predErr) {
                console.error(
                  "[PasswordGatedForm] gateCondition threw; defaulting to gate:",
                  safeErr(predErr),
                );
                shouldGate = true;
              }
            }
            if (shouldGate) {
              const pwd = await promptPassword(prompt);
              if (!pwd) {
                // Cancelled — re-enable so a second attempt works.
                const btnNow = findBtn();
                if (btnNow) btnNow.disabled = false;
                return;
              }
              fd.set("actorPassword", pwd);
            }
            try {
              await action(fd);
              // Success path typically redirects / revalidates; the
              // button lives in a new tree on re-render. If we land
              // here (e.g. action returns without redirect), re-
              // enable so a second submit is possible.
              const btnNow = findBtn();
              if (btnNow) btnNow.disabled = false;
            } catch (err) {
              const btnNow = findBtn();
              if (btnNow) btnNow.disabled = false;
              throw err;
            }
          };
          run().catch((err) => {
            // Surface failures to the console; admin-side actions
            // redirect with ?error=... on known failures, so an
            // unhandled throw here is an unexpected runtime issue.
            // R51: scrub through safeErr to strip PG DETAIL / bound
            // params before logging (even on the client).
            console.error("[PasswordGatedForm] submit failed:", safeErr(err));
          });
        }}
      >
        {children}
      </form>
      {gate}
    </>
  );
}
