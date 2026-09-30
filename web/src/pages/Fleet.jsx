import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, errorText } from '../api.js';
import { Alert, Card, Severity, Spinner } from '../ui.jsx';

export default function Fleet() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/fleet/demo')
      .then((r) => setData(r.data))
      .catch((err) => setError(errorText(err)));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner label="Building the synthetic fleet" />;

  const rows = data.groups.map((g) => ({ ...g, label: `${g.model} · BIOS ${g.bios}` }));
  const pattern = rows.find((g) => g.pattern);

  return (
    <>
      <div className="rounded-lg bg-[#3b2477] px-5 py-3 font-semibold text-white">
        Synthetic data · {data.devices} simulated laptops, fixed seed. This shows what the fleet view does; none of it is measured.
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-3xl font-semibold tracking-tight">Fleet patterns</h1>
        <p className="m-0 text-muted">
          Laptops that share a model and BIOS, compared with the rest of the fleet. {data.daysOfData} days of battery data per laptop. Groups
          under {data.minGroupSize} devices are not reported.
        </p>
      </div>

      {pattern && (
        <Card
          title={`${pattern.label}: battery findings more common`}
          right={<Severity level="Watch">Pattern</Severity>}
        >
          <p className="m-0 max-w-4xl leading-relaxed">
            {pattern.withFinding} of {pattern.devices} laptops in this group ({pattern.ratePct}%) have a battery Watch or Attention finding, compared with{' '}
            {pattern.restRatePct}% of the rest of the fleet. This is a correlation in a small group; it is consistent with a firmware charging issue but
            does not prove one. Check the maker's BIOS release notes before changing anything.
          </p>
          <p className="m-0 text-[13px] text-muted">{data.note}</p>
        </Card>
      )}

      <Card title="Share of laptops with a battery finding, by model and BIOS">
        <div className="h-80 w-full" role="img" aria-label="Bar chart of battery finding rate per model and BIOS group">
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
              <CartesianGrid stroke="#1f2833" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: '#8b98a5' }} />
              <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 13, fill: '#e6edf3' }} />
              <Tooltip formatter={(v, _n, p) => [`${v}% (${p.payload.withFinding} of ${p.payload.devices})`, 'With a finding']} />
              <Bar dataKey="ratePct" isAnimationActive={false} radius={[0, 4, 4, 0]}>
                {rows.map((g) => (
                  <Cell key={g.label} fill={g.pattern ? '#f97316' : '#475569'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <table className="w-full border-collapse text-sm">
          <thead className="text-left text-[13px] text-muted">
            <tr>
              <th className="py-2 font-semibold">Group</th>
              <th className="py-2 text-right font-semibold">Laptops</th>
              <th className="py-2 text-right font-semibold">With a finding</th>
              <th className="py-2 text-right font-semibold">Rate</th>
              <th className="py-2 text-right font-semibold">Rest of fleet</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((g) => (
              <tr key={g.label} className="border-t border-soft">
                <td className="py-2 font-sans font-medium">
                  {g.label} {g.pattern && <span className="ml-2 font-sans text-xs font-semibold text-[#fb923c]">pattern</span>}
                </td>
                <td className="py-2 text-right">{g.devices}</td>
                <td className="py-2 text-right">{g.withFinding}</td>
                <td className="py-2 text-right">{g.ratePct}%</td>
                <td className="py-2 text-right">{g.restRatePct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
