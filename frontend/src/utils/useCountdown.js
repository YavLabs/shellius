import { useState, useEffect } from 'react';

/**
 * useCountdown — returns a human-readable label that updates every second.
 * Returns '' while targetDate is falsy, 'Expired' after the date passes.
 */
export function useCountdown(targetDate) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!targetDate) return;

    const tick = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) {
        setLabel('Expired');
        return;
      }
      const s = Math.floor(diff / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      const d = Math.floor(h / 24);
      if (d > 0) setLabel(`${d}d ${h % 24}h remaining`);
      else if (h > 0) setLabel(`${h}h ${m % 60}m remaining`);
      else if (m > 0) setLabel(`${m}m ${s % 60}s remaining`);
      else setLabel(`${s}s remaining`);
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetDate]);

  return label;
}

export default useCountdown;
