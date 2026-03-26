"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface VirtualKeyboardProps {
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  onClose: () => void;
  visible: boolean;
  label?: string;
  /** Max length of the value string */
  maxLength?: number;
}

const ROW_1 = ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"];
const ROW_2 = ["a", "s", "d", "f", "g", "h", "j", "k", "l"];
const ROW_3 = ["z", "x", "c", "v", "b", "n", "m"];
const SYMBOLS_ROW_1 = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const SYMBOLS_ROW_2 = ["@", "#", "$", "&", "*", "(", ")", "'", "\""];
const SYMBOLS_ROW_3 = ["-", "+", "=", "/", ";", ":", "!", "?"];

export function VirtualKeyboard({
  value,
  onChange,
  onEnter,
  onClose,
  visible,
  label,
  maxLength = 200,
}: VirtualKeyboardProps) {
  const [shifted, setShifted] = useState(false);
  const [symbols, setSymbols] = useState(false);
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

  const press = useCallback((key: string) => {
    if (key === "backspace") {
      onChange(value.slice(0, -1));
    } else if (key === "space") {
      if (value.length < maxLength) onChange(value + " ");
    } else if (key === "enter") {
      onEnter?.();
    } else if (key === "shift") {
      setShifted((s) => !s);
    } else if (key === "symbols") {
      setSymbols((s) => !s);
      setShifted(false);
    } else {
      if (value.length < maxLength) {
        const char = shifted ? key.toUpperCase() : key;
        onChange(value + char);
        if (shifted) setShifted(false);
      }
    }
  }, [value, onChange, onEnter, maxLength, shifted]);

  if (!visible) return null;

  const row1 = symbols ? SYMBOLS_ROW_1 : ROW_1;
  const row2 = symbols ? SYMBOLS_ROW_2 : ROW_2;
  const row3 = symbols ? SYMBOLS_ROW_3 : ROW_3;

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] animate-slide-up" ref={panelRef}>
      {/* Backdrop gradient */}
      <div className="pointer-events-none absolute inset-x-0 -top-16 h-16 bg-gradient-to-t from-black/20 to-transparent" />

      <div className="rounded-t-2xl border-t border-zinc-200 bg-zinc-100 shadow-2xl shadow-black/20">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 bg-white rounded-t-2xl">
          <div className="flex items-center gap-3">
            {label && (
              <span className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">{label}</span>
            )}
          </div>
          {/* Preview */}
          <div className="flex-1 mx-4 overflow-hidden">
            <div className="truncate text-right text-base font-medium text-zinc-900">
              {value || <span className="text-zinc-400">tap to type...</span>}
              <span className="inline-block w-0.5 h-4 bg-teal-500 ml-0.5 animate-pulse align-middle" />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-bold text-teal-600 hover:bg-teal-50 transition-colors"
          >
            Done
          </button>
        </div>

        {/* Keyboard rows */}
        <div className="px-1 py-2 space-y-1.5">
          {/* Row 1 */}
          <div className="flex justify-center gap-[3px]">
            {row1.map((k) => (
              <KbdKey key={k} label={shifted && !symbols ? k.toUpperCase() : k} onPress={() => press(k)} />
            ))}
          </div>

          {/* Row 2 */}
          <div className="flex justify-center gap-[3px]">
            {/* Slight indent for QWERTY layout */}
            {row2.map((k) => (
              <KbdKey key={k} label={shifted && !symbols ? k.toUpperCase() : k} onPress={() => press(k)} />
            ))}
          </div>

          {/* Row 3 with shift + backspace */}
          <div className="flex justify-center gap-[3px]">
            <KbdKey
              label={shifted ? "⬆" : "⇧"}
              onPress={() => press("shift")}
              variant={shifted ? "active" : "action"}
              width="w-12"
            />
            {row3.map((k) => (
              <KbdKey key={k} label={shifted && !symbols ? k.toUpperCase() : k} onPress={() => press(k)} />
            ))}
            <KbdKey label="⌫" onPress={() => press("backspace")} variant="action" width="w-12" />
          </div>

          {/* Row 4 - bottom row */}
          <div className="flex justify-center gap-[3px]">
            <KbdKey
              label={symbols ? "ABC" : "123"}
              onPress={() => press("symbols")}
              variant="action"
              width="w-14"
            />
            <KbdKey label="," onPress={() => press(",")} width="w-8" />
            <KbdKey label="" onPress={() => press("space")} width="flex-1" variant="space" />
            <KbdKey label="." onPress={() => press(".")} width="w-8" />
            <KbdKey
              label="Go"
              onPress={() => press("enter")}
              variant="confirm"
              width="w-14"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function KbdKey({
  label,
  onPress,
  variant = "default",
  width = "w-[9%] min-w-[2rem]",
}: {
  label: string;
  onPress: () => void;
  variant?: "default" | "action" | "active" | "confirm" | "space";
  width?: string;
}) {
  const base = "flex items-center justify-center rounded-lg font-semibold transition-all active:scale-95 select-none touch-manipulation min-h-[2.75rem]";
  const colors =
    variant === "confirm"
      ? "bg-teal-600 text-white text-sm active:bg-teal-700"
      : variant === "active"
        ? "bg-teal-100 text-teal-700 text-base active:bg-teal-200"
        : variant === "action"
          ? "bg-zinc-300 text-zinc-700 text-xs active:bg-zinc-400"
          : variant === "space"
            ? "bg-white text-zinc-400 text-xs active:bg-zinc-50 shadow-sm"
            : "bg-white text-zinc-900 text-base active:bg-zinc-50 shadow-sm";

  return (
    <button
      type="button"
      onClick={onPress}
      className={`${base} ${colors} ${width}`}
    >
      {variant === "space" ? "space" : label}
    </button>
  );
}
