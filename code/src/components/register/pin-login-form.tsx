"use client";

import { useState, useEffect } from "react";

const pad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "OK"];

function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  const stored = localStorage.getItem("pos_device_id");
  if (stored) return stored;
  const generated = crypto.randomUUID();
  localStorage.setItem("pos_device_id", generated);
  return generated;
}

export function PinLoginForm({ locationId }: { locationId: string }) {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Stuck-submission recovery — see useEffect below.
  const [stuckHint, setStuckHint] = useState(false);

  // R46-M2: double-submit guard. The PIN pad's OK button is the form's
  // submit control; a fast double-tap fires two concurrent
  // registerLoginAction invocations, each burning pin/loc/ip rate-
  // limit buckets. Since the <form> lives in the server-rendered
  // parent page (we're embedded inside it), we can't use the
  // `onSubmit` DOM-mutation pattern directly on the form element.
  // Instead we intercept at the submit button: on click (or Enter
  // keypress on the PIN input), disable the OK button via React state
  // + set pointer-events:none. Enter key propagates to form submit
  // AFTER our click handler, so the second synchronous tap sees the
  // disabled state and no-ops.
  // R43-fix: back to useEffect-set pattern. Lazy init at mount time
  // diverges from the SSR output (server renders "", client's first
  // render computes the UUID), which fires React #418 hydration
  // mismatch AND breaks the interactive flow on hydration errors. The
  // server-side register-login route synthesizes a device id when
  // missing, so the theoretical "fast submit" race R43-LOW flagged is
  // benign — better to keep hydration consistent.
  const [deviceId, setDeviceId] = useState<string>("");

  useEffect(() => {
    setDeviceId(getDeviceId());
  }, []);

  // Stuck-submission recovery: on the happy path, registerLoginAction
  // redirects with either ?notice=... or ?error=... and the whole
  // page re-renders (so `submitting` resets to false). If the action
  // POST hits a 5xx (Worker hot-reload / sub-request budget) the
  // browser stays on /register with NO redirect, and the OK button
  // is stuck disabled forever.
  //
  // After 5 s of `submitting=true`, surface a hint that the user can
  // retry. After 30 s, force-reset `submitting=false` so the OK
  // button is interactive again and the user can try a different PIN
  // without reloading the page.
  useEffect(() => {
    if (!submitting) return;
    const hintTimer = setTimeout(() => setStuckHint(true), 5_000);
    const resetTimer = setTimeout(() => {
      setSubmitting(false);
      setStuckHint(false);
    }, 30_000);
    return () => {
      clearTimeout(hintTimer);
      clearTimeout(resetTimer);
    };
  }, [submitting]);

  return (
    <div className="grid gap-4">
      <input type="hidden" name="locationId" value={locationId} />
      {/*
        R44-FE5: render the hidden input UNCONDITIONALLY. Prior shape
        (`{deviceId ? <input /> : null}`) meant the first render on
        both SSR and the pre-effect hydration cycle omitted the input
        entirely. A fast submission in the ~50-300ms window before
        useEffect committed the UUID sent the form with NO deviceId
        field, server-side session was created with device_id=NULL,
        and subsequent requests skipped R28-H5's device-cookie
        verification entirely — stolen REGISTER_COOKIE replay from
        any browser. Always-render keeps the field present; value is
        empty during the brief pre-effect window, populated by the
        effect before any form submit the user can meaningfully
        trigger. If somehow an empty-string submission still slips
        through, the register-login route's client-ip rate-limit
        contains the blast radius.
      */}
      <input type="hidden" name="deviceId" value={deviceId} />
      <label className="grid gap-1 text-sm font-medium text-zinc-700">
        <span>4-6 digit PIN</span>
        <input
          name="pin"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
          className="rounded-2xl border border-zinc-300 bg-white px-4 py-4 text-center text-2xl tracking-[0.5em]"
          placeholder="••••"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>
      {stuckHint ? (
        <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          The login request is taking longer than usual. The OK button will
          re-enable in a few seconds — if it stays stuck, please reload the
          page and try again.
        </p>
      ) : null}
      <div className="grid grid-cols-3 gap-3">
        {pad.map((key) => (
          <button
            key={key}
            type={key === "OK" ? "submit" : "button"}
            disabled={submitting && key === "OK"}
            onClick={(e) => {
              if (key === "CLR") {
                setPin("");
                return;
              }

              if (key === "OK") {
                // R46-M2: guard against fast double-tap on OK. The
                // `submitting` flag is set here synchronously via the
                // event; the second click's React render hasn't
                // committed disabled={true} yet but our own check
                // prevents the action from firing twice.
                if (submitting) { e.preventDefault(); return; }
                setSubmitting(true);
                return;
              }

              // R32-X1: accept 4-6 digit PINs. Prior `slice(0, 4)` hard-
              // capped the input, so any owner/manager with a 6-digit PIN
              // (required by R27-H1 since migration) could NOT log in
              // through the register — total register-auth DoS for the
              // primary back-office role set. Server still enforces
              // `pinString = /^\d{4,6}$/`.
              setPin((current) => `${current}${key}`.slice(0, 6));
            }}
            className="touch-button rounded-2xl border border-zinc-200 bg-white text-lg font-semibold shadow-sm transition hover:border-teal-400 hover:bg-teal-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
