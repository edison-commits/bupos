"use client";

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { VirtualNumpad } from "./virtual-numpad";
import { VirtualKeyboard } from "./virtual-keyboard";

type InputMode = "numpad" | "keyboard" | null;

interface VirtualInputState {
  mode: InputMode;
  value: string;
  label: string;
  allowDecimal: boolean;
  onChange: (v: string) => void;
  onEnter?: () => void;
}

interface VirtualInputContextValue {
  /** Open the virtual numpad for a numeric input */
  openNumpad: (opts: {
    value: string;
    label?: string;
    allowDecimal?: boolean;
    onChange: (v: string) => void;
    onEnter?: () => void;
  }) => void;
  /** Open the virtual keyboard for a text input */
  openKeyboard: (opts: {
    value: string;
    label?: string;
    onChange: (v: string) => void;
    onEnter?: () => void;
  }) => void;
  /** Close any open virtual input */
  close: () => void;
  /** Whether any virtual input is currently open */
  isOpen: boolean;
}

const VirtualInputCtx = createContext<VirtualInputContextValue>({
  openNumpad: () => {},
  openKeyboard: () => {},
  close: () => {},
  isOpen: false,
});

export function useVirtualInput() {
  return useContext(VirtualInputCtx);
}

export function VirtualInputProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<VirtualInputState>({
    mode: null,
    value: "",
    label: "",
    allowDecimal: true,
    onChange: () => {},
    onEnter: undefined,
  });

  const openNumpad = useCallback(
    (opts: { value: string; label?: string; allowDecimal?: boolean; onChange: (v: string) => void; onEnter?: () => void }) => {
      setState({
        mode: "numpad",
        value: opts.value,
        label: opts.label || "",
        allowDecimal: opts.allowDecimal ?? true,
        onChange: opts.onChange,
        onEnter: opts.onEnter,
      });
    },
    [],
  );

  const openKeyboard = useCallback(
    (opts: { value: string; label?: string; onChange: (v: string) => void; onEnter?: () => void }) => {
      setState({
        mode: "keyboard",
        value: opts.value,
        label: opts.label || "",
        allowDecimal: true,
        onChange: opts.onChange,
        onEnter: opts.onEnter,
      });
    },
    [],
  );

  const close = useCallback(() => {
    setState((s) => ({ ...s, mode: null }));
  }, []);

  // Use refs to avoid stale closures while keeping callbacks stable
  const onChangeRef = useRef(state.onChange);
  // eslint-disable-next-line react-hooks/refs
  onChangeRef.current = state.onChange;
  const onEnterRef = useRef(state.onEnter);
  // eslint-disable-next-line react-hooks/refs
  onEnterRef.current = state.onEnter;

  const handleChange = useCallback(
    (v: string) => {
      setState((s) => ({ ...s, value: v }));
      onChangeRef.current(v);
    },
    [],
  );

  const handleEnter = useCallback(() => {
    onEnterRef.current?.();
    close();
  }, [close]);

  return (
    <VirtualInputCtx.Provider value={{ openNumpad, openKeyboard, close, isOpen: state.mode !== null }}>
      {children}
      <VirtualNumpad
        visible={state.mode === "numpad"}
        value={state.value}
        onChange={handleChange}
        onEnter={handleEnter}
        onClose={close}
        label={state.label}
        allowDecimal={state.allowDecimal}
      />
      <VirtualKeyboard
        visible={state.mode === "keyboard"}
        value={state.value}
        onChange={handleChange}
        onEnter={handleEnter}
        onClose={close}
        label={state.label}
      />
    </VirtualInputCtx.Provider>
  );
}
