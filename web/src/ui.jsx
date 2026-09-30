// Small shared pieces. Labels always carry text, never colour alone.

const severityStyle = {
  Urgent: 'bg-[#b42318] text-white',
  Attention: 'bg-[#ffe4d6] text-[#9a3412]',
  Watch: 'bg-[#fff1cc] text-[#7a5200]',
  Information: 'bg-[#e3ecf7] text-[#1d4e89]',
  Normal: 'bg-[#e3f1e7] text-[#1f5f3a]',
};

export function Severity({ level, children }) {
  return (
    <span className={`inline-block rounded-md px-2.5 py-1 text-[13px] font-semibold ${severityStyle[level] ?? 'bg-soft text-[#33383d]'}`}>
      {children ?? level}
    </span>
  );
}

export function Status({ children }) {
  return <span className="inline-block rounded-md bg-soft px-2.5 py-1 text-[13px] font-semibold text-[#33383d]">{children}</span>;
}

// Rule 5: every screen marks data Real (measured) or Simulated.
export function DataLabel({ simulated }) {
  return simulated ? (
    <span className="inline-block rounded-full border-[1.5px] border-dashed border-[#5b3fa0] px-2.5 py-0.5 text-xs font-semibold tracking-wide text-sim">
      SIMULATED
    </span>
  ) : (
    <span className="inline-block rounded-full bg-ink px-2.5 py-0.5 text-xs font-semibold tracking-wide text-white">REAL · measured</span>
  );
}

export function Card({ title, right, children, className = '' }) {
  return (
    <section className={`flex flex-col gap-3 rounded-xl border border-line bg-panel p-6 ${className}`}>
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
    primary: 'bg-brand text-white hover:bg-brand-dark disabled:opacity-50',
    secondary: 'border border-line bg-panel text-ink hover:bg-soft disabled:opacity-50',
    ghost: 'text-brand hover:bg-brand-soft',
  };
  return (
    <button className={`min-h-11 rounded-lg px-5 text-[15px] font-semibold transition-colors ${styles[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Alert({ children, tone = 'error' }) {
  const styles = tone === 'error' ? 'bg-[#fdecea] text-[#8a1c12]' : 'bg-brand-soft text-[#0b3f3c]';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg px-4 py-3 text-sm ${styles}`}>
      {children}
    </div>
  );
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
