"use client";

import { useState, useRef } from "react";
import { VirtualNumpad } from "@/components/ui/virtual-numpad";

interface NumpadInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  prefix?: string;
  allowDecimal?: boolean;
  allowNegative?: boolean;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * A text input that opens a VirtualNumpad on tap/focus instead of the native keyboard.
 * Use for all numeric fields on the POS to keep workers keyboard-free.
 */
export function NumpadInput({
  value,
  onChange,
  placeholder = "0.00",
  label,
  prefix,
  allowDecimal = true,
  allowNegative = false,
  className = "",
  disabled = false,
}: NumpadInputProps) {
  const [showNumpad, setShowNumpad] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="relative">
        {prefix && (
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-bold" style={{ color: 'var(--text-secondary)' }}>
            {prefix}
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          inputMode="none"
          readOnly
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onClick={() => !disabled && setShowNumpad(true)}
          onFocus={(e) => {
            e.target.blur(); // prevent native keyboard
            if (!disabled) setShowNumpad(true);
          }}
          className={`w-full cursor-pointer rounded-2xl border bg-white px-4 py-3 text-lg font-bold tabular-nums focus:ring-2 focus:ring-teal-400 focus:outline-none ${prefix ? 'pl-8' : ''} ${className}`}
          style={{
            borderColor: showNumpad ? 'var(--surface-accent)' : 'var(--border-subtle, #d4d4d8)',
            color: 'var(--text-primary)',
            background: disabled ? 'var(--surface-panel-muted)' : 'var(--surface-panel)',
          }}
        />
      </div>
      <VirtualNumpad
        visible={showNumpad}
        value={value}
        onChange={onChange}
        onEnter={() => setShowNumpad(false)}
        onClose={() => setShowNumpad(false)}
        label={label}
        allowDecimal={allowDecimal}
        allowNegative={allowNegative}
      />
    </>
  );
}
