'use client';

import { useState, useEffect } from 'react';
import { isAudioEnabled, setAudioEnabled } from '@/lib/audio';

export function AudioToggle() {
  const [enabled, setEnabled] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setEnabled(isAudioEnabled());
  }, []);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    setAudioEnabled(next);
  };

  if (!mounted) return null;

  return (
    <button
      onClick={toggle}
      className="touch-button flex items-center gap-2 rounded-xl px-4 py-2 text-base font-bold transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-700"
      title={`Sound ${enabled ? 'on' : 'off'} — tap to toggle`}
      aria-label={`Sound ${enabled ? 'on' : 'off'}. Tap to toggle.`}
    >
      <span className="text-xl">{enabled ? '🔔' : '🔕'}</span>
      <span className="hidden sm:inline">Sound</span>
    </button>
  );
}
