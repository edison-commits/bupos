/**
 * POS Audio Feedback System
 * 
 * Sounds:
 *  - scan-success: high-pitched short beep (880Hz, 100ms)
 *  - scan-fail: low buzz (330Hz, 150ms)
 *  - checkout-complete: two-tone ascending chime
 *  - void: descending tone
 *  - approval-needed: triple beep
 *  - error: harsh buzz
 * 
 * Speech:
 *  - speakTotal(amount): "Your total is twenty-four dollars and twenty-five cents"
 *  - speakChange(amount): "Change due, fifteen dollars"
 * 
 * All sounds use Web Audio API (works offline, no assets needed).
 * Speech uses SpeechSynthesis (works offline on most browsers).
 * 
 * Toggled via localStorage key 'pos-audio-enabled' (default: true for high-contrast, false otherwise).
 */

// ─── Settings ────────────────────────────────────────────

const AUDIO_KEY = 'pos-audio-enabled';

export function isAudioEnabled(): boolean {
  const stored = localStorage.getItem(AUDIO_KEY);
  if (stored !== null) return stored === 'true';
  // Default on for high-contrast mode users
  return document.documentElement.getAttribute('data-theme') === 'high-contrast';
}

export function setAudioEnabled(on: boolean): void {
  localStorage.setItem(AUDIO_KEY, String(on));
}

// ─── Web Audio Helpers ───────────────────────────────────

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(freq: number, duration: number, type: OscillatorType = 'sine', volume = 0.15) {
  if (!isAudioEnabled()) return;
  const ctx = getCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = volume;
  osc.start();
  osc.stop(ctx.currentTime + duration);
  osc.onended = () => { /* ctx reused */ };
}

function playTones(tones: Array<{ freq: number; duration: number; delay: number; type?: OscillatorType; volume?: number }>) {
  if (!isAudioEnabled()) return;
  const ctx = getCtx();
  if (!ctx) return;
  for (const t of tones) {
    setTimeout(() => playTone(t.freq, t.duration, t.type ?? 'sine', t.volume ?? 0.15), t.delay);
  }
}

// ─── Sound Effects ───────────────────────────────────────

/** Item scanned and added to cart */
export function playScanSuccess() {
  playTone(880, 0.1);
}

/** Scan failed (no match) */
export function playScanFail() {
  playTone(330, 0.15);
}

/** Transaction completed — two-tone ascending chime */
export function playCheckoutComplete() {
  playTones([
    { freq: 523, duration: 0.15, delay: 0 },      // C5
    { freq: 784, duration: 0.2, delay: 150 },      // G5
    { freq: 1047, duration: 0.25, delay: 350 },    // C6
  ]);
}

/** Transaction voided — descending tone */
export function playVoid() {
  playTones([
    { freq: 523, duration: 0.15, delay: 0 },
    { freq: 392, duration: 0.2, delay: 150 },
  ]);
}

/** Approval needed — urgent triple beep */
export function playApprovalNeeded() {
  playTones([
    { freq: 880, duration: 0.08, delay: 0 },
    { freq: 880, duration: 0.08, delay: 150 },
    { freq: 880, duration: 0.15, delay: 300 },
  ]);
}

/** Generic error — harsh buzz */
export function playError() {
  playTone(200, 0.3, 'sawtooth', 0.12);
}

/** Item removed from cart */
export function playItemRemoved() {
  playTones([
    { freq: 440, duration: 0.1, delay: 0 },
    { freq: 330, duration: 0.12, delay: 100 },
  ]);
}

// ─── Speech ──────────────────────────────────────────────

function speak(text: string) {
  if (!isAudioEnabled()) return;
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel(); // stop any pending speech
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech not available
  }
}

/** Speak the transaction total: "Total: twenty-four dollars and twenty-five cents" */
export function speakTotal(amount: number) {
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);
  let text = `Total: ${dollars} dollar${dollars !== 1 ? 's' : ''}`;
  if (cents > 0) {
    text += ` and ${cents} cent${cents !== 1 ? 's' : ''}`;
  }
  speak(text);
}

/** Speak change due: "Change: fifteen dollars" */
export function speakChange(amount: number) {
  const dollars = Math.floor(amount);
  const cents = Math.round((amount - dollars) * 100);
  let text = `Change due: ${dollars} dollar${dollars !== 1 ? 's' : ''}`;
  if (cents > 0) {
    text += ` and ${cents} cent${cents !== 1 ? 's' : ''}`;
  }
  speak(text);
}
