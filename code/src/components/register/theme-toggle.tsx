'use client';

import { useState, useEffect } from 'react';

type ThemeMode = 'light' | 'dark' | 'high-contrast';

const STORAGE_KEY = 'pos-theme';

const themes: { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '☀️' },
  { value: 'dark', label: 'Dark', icon: '🌙' },
  { value: 'high-contrast', label: 'High Visibility', icon: '👁️' },
];

function applyTheme(next: ThemeMode) {
  const root = document.documentElement;

  // Clear all theme classes/attributes first
  root.classList.remove('dark');
  root.removeAttribute('data-theme');

  if (next === 'dark') {
    root.classList.add('dark');
  } else if (next === 'high-contrast') {
    root.setAttribute('data-theme', 'high-contrast');
  }
}

export function ThemeToggle() {
  // R36-FE5: lazy init reads the DOM so the button renders with the
  // correct label on first paint. Previously we returned null until
  // mount then flipped in — that caused a layout shift in the POS
  // header (focus order and spacing both jumped). The R35-P7 head
  // script guarantees the html class/data-theme is set pre-hydration,
  // so the first-paint value is available synchronously; SSR returns
  // 'light' (the safe default — no localStorage on server).
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof document === 'undefined') return 'light';
    const root = document.documentElement;
    return root.classList.contains('dark')
      ? 'dark'
      : root.getAttribute('data-theme') === 'high-contrast'
        ? 'high-contrast'
        : 'light';
  });

  useEffect(() => {
    // Reconcile once after mount. With the lazy init above this is
    // almost always a no-op (state already matches DOM) but covers
    // the rare case where the head script was blocked by CSP.
    const root = document.documentElement;
    const current: ThemeMode = root.classList.contains('dark')
      ? 'dark'
      : root.getAttribute('data-theme') === 'high-contrast'
        ? 'high-contrast'
        : 'light';
    setTheme(current);
  }, []);

  const cycleTheme = () => {
    const idx = themes.findIndex((t) => t.value === theme);
    const next = themes[(idx + 1) % themes.length].value;
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  const current = themes.find((t) => t.value === theme)!;

  return (
    <button
      onClick={cycleTheme}
      className="touch-button flex items-center gap-2 rounded-xl px-4 py-2 text-base font-bold transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-700"
      title={`${current.label} mode — tap to switch`}
      aria-label={`Current: ${current.label} mode. Switch theme.`}
    >
      <span className="text-xl">{current.icon}</span>
      <span className="hidden sm:inline">{current.label}</span>
    </button>
  );
}
