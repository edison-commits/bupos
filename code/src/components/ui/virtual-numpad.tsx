"use client";

import { useEffect, useRef } from "react";

interface VirtualNumpadProps {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  onClose: () => void;
  visible: boolean;
  label?: string;
  /** Allow decimal point input (default true) */
  allowDecimal?: boolean;
  /** Allow negative / minus sign (default false) */
  allowNegative?: boolean;
  /** Max length of the value string */
  maxLength?: number;
}

export function VirtualNumpad({
  value,
  onChange,
  onEnter,
  onClose,
  visible,
  label,
  allowDecimal = true,
  allowNegative = false,
  maxLength = 12,
}: VirtualNumpadProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside tap
  useEffect(() => {
    if (!visible) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [visible, onClose]);

  if (!visible) return null;

  function press(key: string) {
    if (key === "backspace") {
      onChange(value.slice(0, -1));
    } else if (key === "clear") {
      onChange("");
    } else if (key === ".") {
      if (!allowDecimal) return;
      if (value.includes(".")) return;
      onChange(value + ".");
    } else if (key === "-") {
      if (!allowNegative) return;
      if (value.startsWith("-")) onChange(value.slice(1));
      else onChange("-" + value);
    } else if (key === "00") {
      if (value.length + 2 <= maxLength) onChange(value + "00");
    } else if (key === "enter") {
      onEnter?.();
    } else {
      // digit 0-9
      if (value.length < maxLength) onChange(value + key);
    }
  }

  const numValue = Number(value) || 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] animate-slide-up" ref={panelRef}>
      {/* Backdrop gradient */}
      <div className="pointer-events-none absolute inset-x-0 -top-16 h-16 bg-gradient-to-t from-black/20 to-transparent" />

      <div className="rounded-t-2xl border-t border-zinc-200 bg-white shadow-2xl shadow-black/20">
        {/* Header bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-100">
          <div className="flex items-center gap-3">
            {label && (
              <span className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{label}</span>
            )}
          </div>
          {/* Display */}
          <div className="flex-1 mx-4 text-right">
            <span className="text-2xl font-extrabold text-zinc-900 tabular-nums">
              {value || "0"}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-bold text-teal-600 hover:bg-teal-50 transition-colors"
          >
            Done
          </button>
        </div>

        {/* Keypad grid */}
        <div className="grid grid-cols-4 gap-[1px] bg-zinc-100 p-[1px]">
          {/* Row 1 */}
          <NumKey label="7" onPress={() => press("7")} />
          <NumKey label="8" onPress={() => press("8")} />
          <NumKey label="9" onPress={() => press("9")} />
          <NumKey label="⌫" onPress={() => press("backspace")} variant="action" />

          {/* Row 2 */}
          <NumKey label="4" onPress={() => press("4")} />
          <NumKey label="5" onPress={() => press("5")} />
          <NumKey label="6" onPress={() => press("6")} />
          <NumKey label="C" onPress={() => press("clear")} variant="action" />

          {/* Row 3 */}
          <NumKey label="1" onPress={() => press("1")} />
          <NumKey label="2" onPress={() => press("2")} />
          <NumKey label="3" onPress={() => press("3")} />
          <NumKey
            label="Enter"
            onPress={() => press("enter")}
            variant="confirm"
            tall
          />

          {/* Row 4 */}
          <NumKey label="0" onPress={() => press("0")} wide />
          <NumKey label={allowDecimal ? "." : "00"} onPress={() => press(allowDecimal ? "." : "00")} />
        </div>
      </div>
    </div>
  );
}

function NumKey({
  label,
  onPress,
  variant = "default",
  wide = false,
  tall = false,
}: {
  label: string;
  onPress: () => void;
  variant?: "default" | "action" | "confirm";
  wide?: boolean;
  tall?: boolean;
}) {
  const base = "flex items-center justify-center font-bold transition-colors active:scale-95 select-none touch-manipulation";
  const size = "min-h-[3.5rem]";
  const colors =
    variant === "confirm"
      ? "bg-teal-600 text-white active:bg-teal-700"
      : variant === "action"
        ? "bg-zinc-200 text-zinc-700 active:bg-zinc-300"
        : "bg-white text-zinc-900 active:bg-zinc-50";
  const fontSize = label === "Enter" ? "text-sm" : label === "⌫" ? "text-xl" : "text-xl";
  const span = wide ? "col-span-2" : "";
  const rowSpan = tall ? "row-span-2" : "";

  return (
    <button
      type="button"
      onClick={onPress}
      className={`${base} ${size} ${colors} ${fontSize} ${span} ${rowSpan}`}
    >
      {label}
    </button>
  );
}
