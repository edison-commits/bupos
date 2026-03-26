"use client";

import { useState, useRef, useCallback } from "react";
import { VirtualNumpad } from "./virtual-numpad";
import { VirtualKeyboard } from "./virtual-keyboard";

interface TouchInputProps {
  /** The current value */
  value: string;
  /** Called when value changes */
  onChange: (value: string) => void;
  /** Called when Enter is pressed on the virtual keyboard */
  onEnter?: () => void;
  /** Input type: "numpad" shows 10-key, "keyboard" shows QWERTY */
  mode: "numpad" | "keyboard";
  /** Label shown in the virtual keyboard header */
  label?: string;
  /** Placeholder when empty */
  placeholder?: string;
  /** Additional classes for the display button */
  className?: string;
  /** Allow decimal in numpad (default true) */
  allowDecimal?: boolean;
  /** Format the display value (e.g., add $ prefix) */
  formatDisplay?: (value: string) => string;
  /** Disable the input */
  disabled?: boolean;
  /** Auto-open the keyboard on mount */
  autoFocus?: boolean;
  /** Also render a native input for physical keyboard fallback */
  hybridInput?: boolean;
  /** ID for the element */
  id?: string;
}

/**
 * A touchscreen-friendly input that opens a virtual numpad or keyboard
 * when tapped. Shows a styled display button that triggers the popup.
 */
export function TouchInput({
  value,
  onChange,
  onEnter,
  mode,
  label,
  placeholder = "Tap to enter...",
  className = "",
  allowDecimal = true,
  formatDisplay,
  disabled = false,
  autoFocus = false,
  hybridInput = true,
  id,
}: TouchInputProps) {
  const [open, setOpen] = useState(autoFocus);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpen = useCallback(() => {
    if (disabled) return;
    setOpen(true);
  }, [disabled]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleEnter = useCallback(() => {
    onEnter?.();
    setOpen(false);
  }, [onEnter]);

  const displayValue = formatDisplay ? formatDisplay(value) : value;

  return (
    <>
      {/* Tappable display that opens the virtual input */}
      <div className={`relative ${className}`} id={id}>
        {hybridInput ? (
          /* Hybrid: real input that can use physical keyboard + tap to open virtual */
          <input
            ref={inputRef}
            type={mode === "numpad" ? "number" : "text"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={handleOpen}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onEnter?.();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            className="w-full rounded-lg border-2 border-[var(--border-subtle)] bg-white px-4 py-3 text-base font-semibold transition-colors focus:border-teal-400 focus:outline-none"
            style={{ color: 'var(--text-primary)' }}
            step={mode === "numpad" && allowDecimal ? "0.01" : undefined}
            inputMode={mode === "numpad" ? "none" : "none"}
          />
        ) : (
          /* Pure virtual: just a button that looks like an input */
          <button
            type="button"
            onClick={handleOpen}
            disabled={disabled}
            className={`w-full rounded-lg border-2 px-4 py-3 text-left text-base font-semibold transition-colors ${
              open
                ? "border-teal-400 bg-white"
                : "border-[var(--border-subtle)] bg-white"
            } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-text"}`}
            style={{ color: value ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >
            {displayValue || placeholder}
          </button>
        )}

        {/* Small keyboard icon indicator */}
        {!disabled && (
          <button
            type="button"
            onClick={handleOpen}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zinc-400 hover:text-teal-600 hover:bg-teal-50 transition-colors"
            title={mode === "numpad" ? "Open numpad" : "Open keyboard"}
          >
            {mode === "numpad" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="2" width="16" height="20" rx="2" />
                <line x1="8" y1="6" x2="8" y2="6.01" /><line x1="12" y1="6" x2="12" y2="6.01" /><line x1="16" y1="6" x2="16" y2="6.01" />
                <line x1="8" y1="10" x2="8" y2="10.01" /><line x1="12" y1="10" x2="12" y2="10.01" /><line x1="16" y1="10" x2="16" y2="10.01" />
                <line x1="8" y1="14" x2="8" y2="14.01" /><line x1="12" y1="14" x2="12" y2="14.01" /><line x1="16" y1="14" x2="16" y2="14.01" />
                <line x1="12" y1="18" x2="12" y2="18.01" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <line x1="6" y1="8" x2="6" y2="8.01" /><line x1="10" y1="8" x2="10" y2="8.01" /><line x1="14" y1="8" x2="14" y2="8.01" /><line x1="18" y1="8" x2="18" y2="8.01" />
                <line x1="6" y1="12" x2="6" y2="12.01" /><line x1="10" y1="12" x2="10" y2="12.01" /><line x1="14" y1="12" x2="14" y2="12.01" /><line x1="18" y1="12" x2="18" y2="12.01" />
                <line x1="8" y1="16" x2="16" y2="16" />
              </svg>
            )}
          </button>
        )}
      </div>

      {/* Virtual input popup */}
      {mode === "numpad" ? (
        <VirtualNumpad
          visible={open}
          value={value}
          onChange={onChange}
          onEnter={handleEnter}
          onClose={handleClose}
          label={label}
          allowDecimal={allowDecimal}
        />
      ) : (
        <VirtualKeyboard
          visible={open}
          value={value}
          onChange={onChange}
          onEnter={handleEnter}
          onClose={handleClose}
          label={label}
        />
      )}
    </>
  );
}
