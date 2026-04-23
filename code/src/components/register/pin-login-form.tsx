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

  return (
    <div className="grid gap-4">
      <input type="hidden" name="locationId" value={locationId} />
      {deviceId ? <input type="hidden" name="deviceId" value={deviceId} /> : null}
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
      <div className="grid grid-cols-3 gap-3">
        {pad.map((key) => (
          <button
            key={key}
            type={key === "OK" ? "submit" : "button"}
            onClick={() => {
              if (key === "CLR") {
                setPin("");
                return;
              }

              if (key === "OK") {
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
            className="touch-button rounded-2xl border border-zinc-200 bg-white text-lg font-semibold shadow-sm transition hover:border-teal-400 hover:bg-teal-50"
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
