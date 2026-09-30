// Small shared pieces. Labels always carry text, never colour alone.

const severityStyle = {
  Urgent: 'bg-[#b42318] text-white',
  Attention: 'bg-[#3b1d0f] text-[#fb923c]',
  Watch: 'bg-[#3a2e0a] text-[#fcd34d]',
  Information: 'bg-[#0f2540] text-[#60a5fa]',
  Normal: 'bg-[#0f2e1c] text-[#86efac]',
};

export function Severity({ level, children }) {
  return (
    <span className={`inline-block rounded-md px-2.5 py-1 text-[13px] font-semibold ${severityStyle[level] ?? 'bg-soft text-[#c3ccd6]'}`}>
      {children ?? level}
    </span>
  );
}

export function Status({ children }) {
  return <span className="inline-block rounded-md bg-soft px-2.5 py-1 text-[13px] font-semibold text-[#c3ccd6]">{children}</span>;
}

// Rule 5: every screen marks data Real (measured) or Simulated.
export function DataLabel({ simulated }) {
  return simulated ? (
    <span className="inline-block rounded-full border-[1.5px] border-dashed border-[#8b7cf6] px-2.5 py-0.5 text-xs font-semibold tracking-wide text-sim">
      SIMULATED
    </span>
  ) : (
    <span className="inline-block rounded-full bg-[#e6edf3] px-2.5 py-0.5 text-xs font-semibold tracking-wide text-[#0a0e13]">REAL · measured</span>
  );
}

export function Card({ title, right, children, className = '' }) {
  return (
    <section className={`spot flex flex-col gap-3 rounded-xl border border-line bg-panel/90 p-6 backdrop-blur-sm ${className}`}>
      {(title || right) && (
        <div className="flex items-center gap-2">
          {title && <h2 className="m-0 flex-grow text-[17px] font-semibold">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, unit, hint }) {
  const missing = value === null || value === undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[13px] text-muted">{label}</div>
      {missing ? (
        <div className="pt-1 text-sm text-muted">{hint ?? 'Not available on this device'}</div>
      ) : (
        <div className="font-mono text-2xl font-semibold">
          {value}
          {unit && <span className="ml-0.5 text-base font-medium text-muted">{unit}</span>}
        </div>
      )}
    </div>
  );
}

export function Button({ children, variant = 'primary', className = '', ...props }) {
  const styles = {
    primary: 'bg-brand text-[#04201d] hover:bg-brand-dark disabled:opacity-50',
    secondary: 'border border-line bg-panel text-ink hover:bg-soft disabled:opacity-50',
    ghost: 'text-brand hover:bg-brand-soft',
  };
  return (
    <button className={`press min-h-11 rounded-lg px-5 text-[15px] font-semibold ${styles[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Alert({ children, tone = 'error' }) {
  const styles = tone === 'error' ? 'bg-[#3a1411] text-[#fca5a5]' : 'bg-brand-soft text-[#99f6e4]';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg px-4 py-3 text-sm ${styles}`}>
      {children}
    </div>
  );
}

// A pulsing dot when a real device reported in the last few minutes.
export function Live({ iso }) {
  const fresh = iso && Date.now() - Date.parse(iso) < 5 * 60_000;
  return fresh ? <span className="live-dot mr-2 align-middle" title="Reporting now" /> : null;
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div role="status" className="flex items-center gap-3 py-10 text-muted">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line border-t-brand" aria-hidden="true" />
      {label}…
    </div>
  );
}
