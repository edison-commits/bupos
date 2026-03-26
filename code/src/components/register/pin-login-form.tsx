"use client";

import { useState } from "react";

const pad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "OK"];

export function PinLoginForm({ locationId }: { locationId: string }) {
  const [pin, setPin] = useState("");

  return (
    <div className="grid gap-4">
      <input type="hidden" name="locationId" value={locationId} />
      <label className="grid gap-1 text-sm font-medium text-zinc-700">
        <span>4-digit PIN</span>
        <input
          name="pin"
          inputMode="numeric"
          maxLength={4}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
          className="rounded-2xl border border-zinc-300 bg-white px-4 py-4 text-center text-2xl tracking-[0.5em]"
          placeholder="••••"
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

              setPin((current) => `${current}${key}`.slice(0, 4));
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
