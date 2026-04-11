'use client';

import { useState, useEffect } from 'react';

type ThemeMode = 'light' | 'dark' | 'high-contrast';

const STORAGE_KEY = 'pos-theme';

const themes: { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '☀️' },
  { value: 'dark', label: 'Dark', icon: '🌙' },
  { value: 'high-contrast', label: 'High Visibility', icon: '👁️' },
];

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    const initial = saved ?? 'light';
    applyTheme(initial);
    setTheme(initial);
  }, []);

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

  const cycleTheme = () => {
    const idx = themes.findIndex((t) => t.value === theme);
    const next = themes[(idx + 1) % themes.length].value;
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  if (!mounted) {
    return null;
  }

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
