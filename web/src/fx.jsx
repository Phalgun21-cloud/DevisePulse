import { useEffect, useRef, useState } from 'react';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// A dot that tracks the pointer, a ring that eases after it and grows over anything clickable,
// and the --mx/--my variables that drive each card's spotlight glow.
export function CursorFX() {
  const dot = useRef(null);
  const ring = useRef(null);

  useEffect(() => {
    if (reduced() || window.matchMedia?.('(pointer: coarse)').matches) return undefined;
    let x = -100;
    let y = -100;
    let rx = x;
    let ry = y;
    let frame;
    const move = (e) => {
      x = e.clientX;
      y = e.clientY;
      if (dot.current) dot.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      const card = e.target.closest?.('.spot');
      if (card) {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${x - r.left}px`);
        card.style.setProperty('--my', `${y - r.top}px`);
      }
      ring.current?.classList.toggle('hot', !!e.target.closest?.('a, button, summary, input, [role="button"]'));
    };
    const tick = () => {
      rx += (x - rx) * 0.18;
      ry += (y - ry) * 0.18;
      if (ring.current) ring.current.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', move, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <div ref={ring} className="cursor-ring" aria-hidden="true" />
      <div ref={dot} className="cursor-dot" aria-hidden="true" />
    </>
  );
}

export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

// Counts up to a number once. Non-numbers render as they are.
export function CountUp({ value, decimals = 0, duration = 900 }) {
  const [shown, setShown] = useState(typeof value === 'number' && !reduced() ? 0 : value);
  useEffect(() => {
    if (typeof value !== 'number' || reduced()) {
      setShown(value);
      return undefined;
    }
    let frame;
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / duration);
      setShown(value * (1 - (1 - p) ** 3));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return typeof shown === 'number' ? shown.toFixed(decimals) : shown;
}
