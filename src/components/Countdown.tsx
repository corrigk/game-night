import { useEffect, useRef, useState } from 'react';
import { secondsLeft } from '../lib/clock';
import { play } from '../lib/sound';

/** Re-render on an interval (for countdowns). */
export function useNow(ms = 250) {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setT((t) => t + 1), ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** Circular countdown driven by rooms.timer_ends_at (server time). */
export function Countdown({
  endsAt,
  duration,
  size = 'md',
  sound = false,
}: {
  endsAt: string | null;
  duration: number | null;
  size?: 'sm' | 'md' | 'lg';
  sound?: boolean;
}) {
  useNow(200);
  const left = secondsLeft(endsAt);
  const whole = left == null ? null : Math.ceil(left);
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    if (!sound || whole == null) return;
    if (whole <= 5 && whole > 0 && lastTick.current !== whole) play('tick');
    lastTick.current = whole;
  }, [whole, sound]);

  if (left == null || whole == null) return null;
  const frac = duration ? Math.max(0, Math.min(1, left / duration)) : 0;
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <div className={`countdown countdown-${size}${whole <= 5 ? ' countdown-urgent' : ''}`} aria-label={`${whole} seconds left`}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} className="countdown-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="countdown-bar"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span className="countdown-num">{whole}</span>
    </div>
  );
}
