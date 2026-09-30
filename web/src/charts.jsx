import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const DAY = 86_400_000;

export function timeTick(spanMs) {
  return (t) => {
    const d = new Date(t);
    if (spanMs <= 2 * DAY) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (spanMs <= 120 * DAY) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  };
}

export const fmtWhen = (t) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const bucketLabel = (ms) => {
  const m = ms / 60_000;
  if (m < 60) return `${m}-minute`;
  if (m < 1440) return `${m / 60}-hour`;
  return `${m / 1440}-day`;
};

// Flatten { field: {avg,min,max} } points into chart rows: avg line + [min,max] band. Gap rows stay null.
export function rowsFor(series, field) {
  return (series?.points ?? []).map((p) => ({
    t: p.t,
    avg: p[field]?.avg ?? null,
    band: p[field] ? [p[field].min, p[field].max] : null,
  }));
}

// Average line over a min-max band for one metric across the selected range.
export function MetricChart({ series, field, unit = '', color = '#0b5e5a', domain = ['auto', 'auto'], refs = [], height = 240, digits = 1 }) {
  const rows = rowsFor(series, field);
  const span = series ? Date.parse(series.to) - Date.parse(series.from) : DAY;
  const fmt = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}${unit}`);
  return (
    <div style={{ height }} className="w-full" role="img" aria-label={`${field} over the selected range`}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`g-${field}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0.06} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#eceae2" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={series ? [Date.parse(series.from), Date.parse(series.to)] : ['dataMin', 'dataMax']}
            tickFormatter={timeTick(span)}
            tick={{ fontSize: 12, fill: '#4a5056' }}
            minTickGap={28}
          />
          <YAxis domain={domain} width={52} tick={{ fontSize: 12, fill: '#4a5056' }} tickFormatter={(v) => `${Number.isInteger(v) ? v : Number(v).toFixed(digits > 1 ? 2 : 1)}${unit}`} />
          <Tooltip
            labelFormatter={(t) => fmtWhen(t)}
            formatter={(v, name) => (Array.isArray(v) ? [`${fmt(v[0])} – ${fmt(v[1])}`, 'Range in bucket'] : [fmt(v), 'Average'])}
            contentStyle={{ borderRadius: 12, border: '1px solid #dedcd3' }}
          />
          {refs.map((r) => (
            <ReferenceLine key={r.y} y={r.y} stroke={r.color} strokeDasharray="5 4" label={{ value: r.label, position: 'insideTopRight', fill: r.color, fontSize: 11 }} />
          ))}
          <Area dataKey="band" stroke="none" fill={`url(#g-${field})`} isAnimationActive animationDuration={700} connectNulls={false} />
          <Line dataKey="avg" stroke={color} strokeWidth={2.2} dot={false} isAnimationActive animationDuration={700} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// avg / min / peak / latest / readings for a metric over the range. Missing data says so.
export function StatStrip({ stats, unit = '', digits = 1 }) {
  if (!stats || stats.count === 0) return <div className="text-sm text-muted">No readings in this range.</div>;
  const f = (v) => `${Number(v).toFixed(digits)}${unit}`;
  const items = [
    ['Average', f(stats.avg)],
    ['Lowest', f(stats.min)],
    ['Peak', f(stats.max)],
    ['Latest', f(stats.latest)],
    ['Readings', stats.count.toLocaleString()],
  ];
  return (
    <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-ground/70 px-3 py-2">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="m-0 font-mono text-[15px] font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
