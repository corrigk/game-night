import { load, save } from './storage';

/**
 * Tiny synthesized sound effects (no audio files to license or download).
 * TV only. Muted by default; the host toggles it from the drawer.
 */
export type Sfx = 'tick' | 'pop' | 'sting' | 'fanfare';

const KEY = 'partypack:muted';
let muted = load<boolean>(KEY, true);
let ctx: AudioContext | null = null;
const listeners = new Set<(m: boolean) => void>();

export const isMuted = () => muted;

export function setMuted(m: boolean) {
  muted = m;
  save(KEY, m);
  listeners.forEach((fn) => fn(m));
  if (!m) unlockAudio();
}

export function onMuteChange(fn: (m: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Browsers only allow audio after a user gesture; call from key/click handlers. */
export function unlockAudio() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.2) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}

export function play(sfx: Sfx) {
  if (muted) return;
  unlockAudio();
  switch (sfx) {
    case 'tick':
      tone(1200, 0, 0.05, 'square', 0.08);
      break;
    case 'pop':
      tone(520, 0, 0.08, 'triangle', 0.25);
      tone(880, 0.04, 0.08, 'triangle', 0.2);
      break;
    case 'sting':
      tone(196, 0, 0.5, 'sawtooth', 0.12);
      tone(247, 0.08, 0.5, 'sawtooth', 0.12);
      tone(294, 0.16, 0.7, 'sawtooth', 0.14);
      break;
    case 'fanfare':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.3, 'square', 0.12));
      tone(1047, 0.5, 0.8, 'square', 0.14);
      tone(784, 0.5, 0.8, 'square', 0.1);
      break;
  }
}
