/**
 * useEscapeClose — close a modal/dialog when the user presses Escape.
 *
 * FE-AUDIT5-HIGH3: every dialog should be Escape-dismissable for
 * keyboard users. Reaches for `document.addEventListener` so it works
 * regardless of whether the dialog has focus inside it (a fresh-mounted
 * modal often hasn't received focus yet — a focus-trap library would
 * fix that, but Escape needs to work even before focus lands).
 *
 * Pair with:
 *   - `role="dialog" aria-modal="true" aria-label="…"` on the outer div
 *   - `onClick={onClose}` on the backdrop (or stopPropagation in the
 *     content panel) for click-outside-to-close
 *   - A focus trap if the modal contains a form (out of scope here)
 *
 * Cleanup: removes the listener on unmount or onClose change. The
 * latter is unusual but safe — React-stable callbacks won't re-run
 * the effect.
 */
"use client";
import { useEffect } from "react";

export function useEscapeClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop propagation so a parent dialog (nested case) doesn't
        // also close on the same keystroke. The browser still gets to
        // dismiss native UI like an open select dropdown — the
        // listener fires AFTER the browser's default behavior on the
        // dropdown.
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}
