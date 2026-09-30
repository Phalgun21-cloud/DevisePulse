import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';

const DAY_MS = 86_400_000;
const fmtMonth = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });

// History as a line; the forecast as a RANGE (fast bound to slow bound) toward the replacement threshold.
// No single forecast date is drawn or labelled (rule 1).
export function BatteryChart({ history, battery }) {
  const rows = history.map((p) => ({ t: Date.parse(p.date), health: p.healthPct }));
  const f = battery.forecast;
  const last = rows[rows.length - 1];

  if (f && !f.alreadyBelowThreshold && last && f.daysFromLastSampleLow > 0) {
    const thr = f.thresholdPct;
    const gap = last.health - thr;
    const lowDays = f.daysFromLastSampleLow;
    const highDays = f.daysFromLastSampleHigh; // null = open-ended
    const horizon = Math.min(Math.max(highDays ?? lowDays * 2, lowDays) * 1.1, 900);
    rows[rows.length - 1] = { ...last, band: [last.health, last.health] };
    for (let d = horizon / 12; d <= horizon + 1e-9; d += horizon / 12) {
      const fast = Math.max(thr, last.health - (gap * d) / lowDays);
      const slow = highDays ? Math.max(thr, last.health - (gap * d) / highDays) : last.health;
      rows.push({ t: last.t + d * DAY_MS, band: [fast, slow] });
    }
  }

  const values = rows.flatMap((r) => [r.health, ...(r.band ?? [])]).filter((v) => typeof v === 'number');
  const yMin = Math.floor(Math.min(battery.thresholdPct, ...values) / 5) * 5 - 5;
  const yMax = Math.min(100, Math.ceil(Math.max(...values) / 5) * 5 + 2);

  return (
    <div className="h-72 w-full" role="img" aria-label={`Battery health history${f ? ' with forecast range' : ''}`}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#eceae2" vertical={false} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={fmtMonth} tick={{ fontSize: 12, fill: '#4a5056' }} />
          <YAxis domain={[yMin, yMax]} tickFormatter={(v) => `${v}%`} width={48} tick={{ fontSize: 12, fill: '#4a5056' }} />
          <Tooltip
            labelFormatter={(t) => new Date(t).toLocaleDateString()}
            formatter={(v, name) => (Array.isArray(v) ? [`${v[0].toFixed(1)}% to ${v[1].toFixed(1)}%`, 'Forecast range'] : [`${v}%`, 'Health'])}
          />
          <ReferenceLine y={battery.watchBelowPct} stroke="#b98a1e" strokeDasharray="4 4" label={{ value: `Watch below ${battery.watchBelowPct}%`, position: 'insideTopRight', fill: '#7a5200', fontSize: 12 }} />
          <ReferenceLine y={battery.thresholdPct} stroke="#9a3412" strokeDasharray="6 4" label={{ value: `Replacement threshold ${battery.thresholdPct}%`, position: 'insideBottomRight', fill: '#9a3412', fontSize: 12 }} />
          <Area dataKey="band" stroke="none" fill="#f5c8ae" fillOpacity={0.8} isAnimationActive={false} connectNulls />
          <Line dataKey="health" stroke="#0b5e5a" strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
