import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, errorText } from '../api.js';
import { BatteryChart } from '../BatteryChart.jsx';
import { DeviceSettings } from '../DeviceSettings.jsx';
import { MetricChart, StatStrip, bucketLabel, fmtWhen } from '../charts.jsx';
import { CountUp } from '../fx.jsx';
import { Alert, Button, Card, DataLabel, Live, Severity, Spinner, Stat, Status, timeAgo } from '../ui.jsx';

// ---- constants --------------------------------------------------------------------------------
const TABS = [
  ['overview', 'Overview'],
  ['performance', 'Performance'],
  ['storage', 'Storage'],
  ['battery', 'Battery'],
  ['findings', 'Findings'],
  ['diagnoses', 'Diagnoses'],
  ['raw', 'Raw data'],
  ['settings', 'Settings'],
];
const RANGES = [
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'All time'],
];
const probeStatus = {
  no_data: 'No readings yet',
  collecting_baseline: 'Building baseline (3 days)',
  not_enough_recent: 'Waiting for recent readings',
  ok: 'Compared with baseline',
};
const thermalStatus = {
  no_data: 'No temperature or speed data',
  collecting_baseline: 'Building baseline (7 days)',
  no_comparable_load: 'No comparable load recently',
  ok: 'Compared with baseline',
};
const fmtRange = (f) => {
  if (f.monthsHigh === null) return `at least ${f.monthsLow} months`;
  if (Math.round(f.monthsLow) === Math.round(f.monthsHigh)) return `about ${Math.round(f.monthsLow)} months`;
  return `roughly ${f.monthsLow} to ${f.monthsHigh} months`;
};
const dayIso = (t) => new Date(t).toISOString().slice(0, 10);

// ---- small pieces -------------------------------------------------------------------------
function Evidence({ value }) {
  if (value === null || value === undefined) return <span className="text-muted">not available</span>;
  if (Array.isArray(value)) return <span className="font-mono">{value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)).join(', ')}</span>;
  if (typeof value === 'object') return <pre className="m-0 whitespace-pre-wrap font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
  return <span className="font-mono">{String(value)}</span>;
}

function Finding({ f }) {
  return (
    <div className="flex flex-col gap-3 border-t border-soft py-5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-3">
        <Severity level={f.severity} />
        <h3 className="m-0 flex-grow text-base font-semibold">{f.title}</h3>
        <DataLabel simulated={f.data === 'Simulated'} />
        {f.status === 'cleared' && <Status>Cleared</Status>}
      </div>
      <div className="text-[13px] text-muted">
        First seen {fmtWhen(f.firstSeen)} · {f.status === 'cleared' ? 'cleared' : 'last confirmed'} {fmtWhen(f.lastSeen)}
      </div>
      <p className="m-0 max-w-4xl leading-relaxed">{f.explanation}</p>
      <details className="rounded-lg bg-ground px-4 py-2">
        <summary className="min-h-8 cursor-pointer py-1 text-sm font-semibold">Evidence</summary>
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 py-2 text-sm sm:grid-cols-[max-content_1fr]">
          {Object.entries(f.evidence)
            .filter(([k]) => k !== 'forecast' || f.rule !== 'battery_wear')
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="m-0">
                  <Evidence value={v} />
                </dd>
              </div>
            ))}
        </dl>
      </details>
    </div>
  );
}

function Kpi({ label, value, unit, digits = 0, hint, missingHint, tone }) {
  const missing = value === null || value === undefined;
  return (
    <div className="spot flex flex-col gap-1 rounded-xl border border-line bg-panel/90 p-5 backdrop-blur-sm">
      <div className="text-[13px] text-muted">{label}</div>
      {missing ? (
        <div className="pt-2 text-sm text-muted">{missingHint ?? 'Not available'}</div>
      ) : (
        <div className={`font-mono text-3xl font-semibold ${tone ?? ''}`}>
          <CountUp value={value} decimals={digits} />
          {unit && <span className="ml-0.5 text-lg text-muted">{unit}</span>}
        </div>
      )}
      {!missing && hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

function NotAvailable({ title, children }) {
  return (
    <Card title={title} right={<Status>Not available on this device</Status>}>
      <p className="m-0 max-w-3xl text-sm text-muted">{children}</p>
    </Card>
  );
}

function ChartCard({ title, series, field, unit, digits, domain, refs, color, empty }) {
  const stats = series?.stats?.[field];
  if (series && stats?.count === 0) return <NotAvailable title={title}>{empty ?? 'No readings of this kind in the selected range.'}</NotAvailable>;
  return (
    <Card title={title} right={series && <span className="text-xs text-muted">{bucketLabel(series.bucketMs)} averages · shaded: min–max</span>}>
      {series ? <MetricChart series={series} field={field} unit={unit} digits={digits} domain={domain} refs={refs} color={color} /> : <Spinner label="Loading chart" />}
      <StatStrip stats={stats} unit={unit} digits={digits} />
    </Card>
  );
}

// ---- tabs ---------------------------------------------------------------------------------
function Overview({ device, summary, series, findings, onTab }) {
  const { battery, latest } = summary;
  const cpu = latest.cpu?.values ?? {};
  const st = latest.storage?.values ?? {};
  const active = findings.filter((f) => f.status === 'active');
  return (
    <>
      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Active findings" value={active.length} hint={active.length ? 'see Findings' : 'nothing to act on'} tone={active.length ? 'text-[#9a3412]' : ''} />
        <Kpi label="Battery health" value={battery.healthPct} unit="%" digits={1} hint="of original capacity" missingHint="No battery reading" />
        <Kpi label="Avg CPU (range)" value={series.cpu?.stats.cpuLoadPct.avg ?? null} unit="%" digits={1} hint={`${series.cpu?.stats.cpuLoadPct.count ?? 0} readings`} missingHint={series.cpu ? 'No CPU readings in range' : 'Loading…'} />
        <Kpi label="Peak memory (range)" value={series.cpu?.stats.memUsedPct.max ?? null} unit="%" digits={1} hint={`average ${series.cpu?.stats.memUsedPct.avg ?? '—'}%`} missingHint={series.cpu ? 'No memory readings in range' : 'Loading…'} />
        <Kpi label="Disk test (avg)" value={series.storage?.stats.ioProbeMs.avg ?? null} unit=" ms" digits={1} hint={`peak ${series.storage?.stats.ioProbeMs.max ?? '—'} ms`} missingHint={series.storage ? 'No disk tests in range' : 'Loading…'} />
      </div>

      <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Battery" right={battery.status === 'collecting' ? <Status>Collecting data</Status> : battery.forecast ? <Status>Trend available</Status> : <Severity level="Normal">Stable</Severity>}>
          <Stat label="Health (of original capacity)" value={battery.healthPct} unit="%" hint="No battery reading yet" />
          {latest.battery && (
            <div className="font-mono text-sm text-[#33383d]">
              {latest.battery.values.fullChargeWh} Wh now · {latest.battery.values.designWh} Wh when new
            </div>
          )}
          {battery.status === 'collecting' ? (
            <div className="text-[13px] text-muted">
              {battery.points} of {battery.needsPoints} days of readings, over {battery.spanDays} of {battery.needsSpanDays} days. No forecast until then.
            </div>
          ) : battery.forecast?.alreadyBelowThreshold ? (
            <div className="text-sm">At or below the {battery.thresholdPct}% replacement threshold.</div>
          ) : battery.forecast ? (
            <div className="text-sm">
              May reach {battery.forecast.thresholdPct}% in <strong>{fmtRange(battery.forecast)}</strong> (confidence: {battery.forecast.confidence}).
            </div>
          ) : (
            <div className="text-sm text-muted">No meaningful decline.</div>
          )}
        </Card>
        <Card title="Processor and memory" right={latest.cpu ? <span className="text-[13px] text-muted">{timeAgo(latest.cpu.ts)}</span> : <Status>No readings yet</Status>}>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="CPU load" value={cpu.cpuLoadPct} unit="%" hint={latest.cpu ? undefined : '—'} />
            <Stat label="Memory used" value={cpu.memUsedPct} unit="%" hint={latest.cpu ? undefined : '—'} />
            <Stat label="Speed vs base clock" value={cpu.cpuFreqRatio != null ? `${cpu.cpuFreqRatio}×` : null} hint={latest.cpu ? undefined : '—'} />
            <Stat label="Power" value={cpu.pluggedIn == null ? null : cpu.pluggedIn ? 'Mains' : 'Battery'} hint={latest.cpu ? undefined : '—'} />
          </div>
        </Card>
        <Card title="Storage" right={<Status>{probeStatus[summary.storage.status.probe] ?? summary.storage.status.probe}</Status>}>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="Timed 8 MB write + read" value={st.ioProbeMs} unit=" ms" hint={latest.storage ? undefined : '—'} />
            <Stat label="Free space" value={st.freeSpacePct} unit="%" hint={latest.storage ? undefined : '—'} />
            <Stat label="Wear (endurance used)" value={st.percentageUsed} unit="%" hint={latest.storage ? undefined : '—'} />
            <Stat label="SMART self-check" value={st.smartPassed == null ? null : st.smartPassed ? 'Passed' : 'Failed'} hint={latest.storage ? undefined : '—'} />
          </div>
        </Card>
      </div>

      {(series.cpu?.sampleCount ?? 0) > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard title="CPU load" series={series.cpu} field="cpuLoadPct" unit="%" domain={[0, 100]} />
          <ChartCard title="Memory used" series={series.cpu} field="memUsedPct" unit="%" domain={[0, 100]} color="#4b2f8f" />
        </div>
      )}

      <Card title="Active findings" right={findings.length > 0 && <Button variant="ghost" onClick={() => onTab('findings')}>All findings →</Button>}>
        {active.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-[#c9c6ba] p-7 text-center">
            <div className="font-semibold">No findings</div>
            <div className="max-w-2xl text-sm text-muted">A finding is shown only after two checks in a row agree, and it clears after three normal checks.</div>
          </div>
        ) : (
          active.map((f) => <Finding key={f.id} f={f} />)
        )}
      </Card>
    </>
  );
}

function Performance({ series, summary }) {
  const c = series.cpu;
  return (
    <>
      <ChartCard title="CPU load" series={c} field="cpuLoadPct" unit="%" domain={[0, 100]} refs={[{ y: 85, label: 'Diagnose: busy 85%', color: '#9a3412' }]} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Memory used" series={c} field="memUsedPct" unit="%" domain={[0, 100]} color="#4b2f8f" refs={[{ y: 90, label: '90%', color: '#9a3412' }]} />
        <ChartCard
          title="Processor speed (× base clock)"
          series={c}
          field="cpuFreqRatio"
          unit="×"
          digits={2}
          color="#b45309"
          refs={[{ y: 0.75, label: 'Throttling below 0.75× under load', color: '#9a3412' }]}
          empty="This device does not report processor speed."
        />
        <ChartCard
          title="CPU temperature"
          series={c}
          field="cpuTempC"
          unit=" °C"
          color="#b42318"
          empty="Temperature is not exposed on this device (common on Windows). DevicePulse does not guess; it watches processor speed under sustained load instead."
        />
        <ChartCard title="Swap used" series={c} field="swapUsedPct" unit="%" domain={[0, 100]} color="#1d4e89" />
      </div>
      <Card title="Thermal check" right={<Status>{thermalStatus[summary.thermal.status] ?? summary.thermal.status}</Status>}>
        <p className="m-0 max-w-3xl text-sm text-muted">
          Compares temperature (or, without it, processor speed under sustained load) with this device's own first week, only at similar load and on the
          same power source, so being busier or unplugged is not mistaken for overheating.
        </p>
      </Card>
    </>
  );
}

function StorageTab({ series, summary }) {
  const s = series.storage;
  const st = summary.latest.storage?.values ?? {};
  const smart = [
    ['SMART self-check', st.smartPassed == null ? null : st.smartPassed ? 'Passed' : 'Failed'],
    ['Critical warning flag', st.criticalWarning],
    ['Spare blocks', st.availableSparePct == null ? null : `${st.availableSparePct}% (minimum ${st.availableSpareThresholdPct ?? '?'}%)`],
    ['Rated endurance used', st.percentageUsed == null ? null : `${st.percentageUsed}%`],
    ['Media errors', st.mediaErrors],
    ['Reallocated sectors', st.reallocatedSectors],
    ['Pending sectors', st.pendingSectors],
  ];
  return (
    <>
      <ChartCard title="Timed disk test (8 MB write + fsync + read)" series={s} field="ioProbeMs" unit=" ms" color="#0b5e5a" empty="No disk tests in this range. The agent runs one every 15 minutes." />
      <ChartCard
        title="Free space"
        series={s}
        field="freeSpacePct"
        unit="%"
        domain={[0, 100]}
        color="#1d4e89"
        refs={[
          { y: 10, label: 'Information below 10%', color: '#1d4e89' },
          { y: 5, label: 'Watch below 5%', color: '#9a3412' },
        ]}
      />
      <Card title="Drive health (SMART)" right={<Status>{probeStatus[summary.storage.status.probe] ?? summary.storage.status.probe}</Status>}>
        <dl className="m-0 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          {smart.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-soft py-2">
              <dt className="text-muted">{k}</dt>
              <dd className="m-0 font-mono">{v === null || v === undefined ? <span className="font-sans text-muted">Not available on this device</span> : String(v)}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 text-xs text-muted">SMART needs smartmontools (and usually Administrator). Without it only the timed disk test and free space are measured.</p>
      </Card>
    </>
  );
}

function BatteryTab({ device, summary, series, range }) {
  const { battery } = summary;
  const history = useMemo(() => {
    const from = series.battery ? series.battery.from.slice(0, 10) : '0000';
    return summary.batteryHistory.filter((p) => range === 'all' || p.date >= from);
  }, [summary.batteryHistory, series.battery, range]);
  return (
    <>
      <Card title="Battery health over time" right={<DataLabel simulated={device.isSimulated} />}>
        {history.length > 1 ? (
          <>
            <BatteryChart history={history} battery={battery} />
            {battery.forecast && !battery.forecast.alreadyBelowThreshold && (
              <p className="m-0 text-[13px] text-muted">
                Shaded: forecast range (about 95%): may reach {battery.forecast.thresholdPct}% in {fmtRange(battery.forecast)} (confidence {battery.forecast.confidence}). It is a
                range of possibilities, not a date the battery will stop working.
              </p>
            )}
          </>
        ) : (
          <p className="m-0 text-sm text-muted">
            {battery.status === 'collecting'
              ? `Collecting data: ${battery.points} of ${battery.needsPoints} days over ${battery.spanDays} of ${battery.needsSpanDays} days. The trend appears after that.`
              : 'Not enough daily readings in this range. Try a longer range.'}
          </p>
        )}
        <StatStrip stats={series.battery?.stats.healthPct} unit="%" />
      </Card>
      <ChartCard title="Charge level" series={series.battery} field="percent" unit="%" domain={[0, 100]} color="#16a37a" empty="No charge-level readings in this range." />
      <ChartCard title="Full-charge capacity" series={series.battery} field="fullChargeWh" unit=" Wh" color="#b45309" />
    </>
  );
}

function FindingsTab({ findings }) {
  const [filter, setFilter] = useState('all');
  const shown = findings
    .filter((f) => f.status !== 'pending')
    .filter((f) => filter === 'all' || f.status === filter)
    .sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1));
  return (
    <Card
      title="Findings timeline"
      right={
        <div className="flex gap-1 rounded-lg bg-ground p-1" role="group" aria-label="Filter findings">
          {['all', 'active', 'cleared'].map((k) => (
            <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className={`min-h-9 rounded-md px-3 text-sm capitalize ${filter === k ? 'bg-panel font-semibold shadow-sm' : 'text-muted'}`}>
              {k}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? <div className="py-6 text-center text-sm text-muted">No {filter === 'all' ? '' : filter} findings.</div> : shown.map((f) => <Finding key={f.id} f={f} />)}
    </Card>
  );
}

function DiagnosesTab({ device }) {
  const [reqs, setReqs] = useState(null);
  useEffect(() => {
    api.get(`/devices/${device.id}/diagnose`).then((r) => setReqs(r.data.requests)).catch(() => setReqs([]));
  }, [device.id]);
  if (!reqs) return <Spinner label="Loading diagnoses" />;
  return (
    <Card
      title="Slow-laptop diagnoses"
      right={
        !device.isSimulated && (
          <Link to={`/devices/${device.id}/diagnose`} className="press inline-flex min-h-10 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white no-underline hover:bg-brand-dark hover:text-white">
            Run a diagnosis
          </Link>
        )
      }
    >
      {reqs.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">{device.isSimulated ? 'Simulated devices have no agent to diagnose.' : 'No diagnoses yet.'}</div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead className="text-left text-[13px] text-muted">
            <tr>
              <th className="py-2 font-semibold">When</th>
              <th className="py-2 font-semibold">Status</th>
              <th className="py-2 font-semibold">Result</th>
              <th className="py-2 text-right font-semibold">CPU</th>
              <th className="py-2 text-right font-semibold">Memory</th>
            </tr>
          </thead>
          <tbody>
            {reqs.map((r) => (
              <tr key={r.id} className="border-t border-soft">
                <td className="py-2 font-mono">{fmtWhen(r.completedAt ?? r.createdAt)}</td>
                <td className="py-2 capitalize">{r.status}</td>
                <td className="py-2">{r.result ? (r.result.causes.length ? r.result.causes.map((c) => `${c.rule.replace('_', ' ')}${c.process ? ` (${c.process})` : ''}`).join(', ') : 'No clear cause') : '—'}</td>
                <td className="py-2 text-right font-mono">{r.sample?.cpuPct ?? '—'}%</td>
                <td className="py-2 text-right font-mono">{r.sample?.memUsedPct ?? '—'}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function RawTab({ device, window }) {
  const [kind, setKind] = useState('cpu');
  const [rows, setRows] = useState(null);
  useEffect(() => {
    setRows(null);
    api
      .get(`/devices/${device.id}/samples`, { params: { kind, from: window.from, to: window.to, limit: 2000 } })
      .then((r) => setRows(r.data.samples))
      .catch(() => setRows([]));
  }, [device.id, kind, window.from, window.to]);
  const cols = useMemo(() => [...new Set((rows ?? []).flatMap((r) => Object.keys(r.values)))], [rows]);

  function exportCsv() {
    const esc = (v) => (v === null || v === undefined ? '' : `"${String(v).replaceAll('"', '""')}"`);
    const lines = [['ts', ...cols].join(','), ...rows.map((r) => [r.ts, ...cols.map((c) => r.values[c])].map(esc).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${device.name.replace(/\W+/g, '-')}-${kind}-${dayIso(Date.now())}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card
      title="Raw readings"
      right={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="min-h-10 rounded-lg border border-line bg-panel px-2">
              <option value="cpu">Processor and memory</option>
              <option value="storage">Storage</option>
              <option value="battery">Battery</option>
            </select>
          </label>
          <Button variant="secondary" className="!min-h-10 !px-4 text-sm" onClick={exportCsv} disabled={!rows?.length}>
            Export CSV
          </Button>
        </div>
      }
    >
      {!rows ? (
        <Spinner label="Loading readings" />
      ) : rows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted">No readings of this kind in the selected range.</div>
      ) : (
        <>
          <div className="text-xs text-muted">
            {rows.length.toLocaleString()} readings{rows.length === 2000 ? ' (latest 2,000 in range)' : ''}. Empty cells mean not measured, never zero.
          </div>
          <div className="max-h-[520px] overflow-auto rounded-lg border border-soft">
            <table className="w-full border-collapse font-mono text-xs">
              <thead className="sticky top-0 bg-soft text-left font-sans text-[12px] text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Time</th>
                  {cols.map((c) => (
                    <th key={c} className="px-3 py-2 font-semibold">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.ts} className="border-t border-soft hover:bg-brand-soft/50">
                    <td className="whitespace-nowrap px-3 py-1.5">{fmtWhen(r.ts)}</td>
                    {cols.map((c) => (
                      <td key={c} className="px-3 py-1.5">
                        {r.values[c] === null || r.values[c] === undefined ? '' : String(r.values[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// ---- page ---------------------------------------------------------------------------------
export default function DeviceDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const range = params.get('range') ?? (params.get('from') ? 'custom' : '7d');
  const window = useMemo(
    () => (range === 'custom' ? { from: params.get('from'), to: params.get('to') } : { range }),
    [range, params],
  );

  const [data, setData] = useState(null);
  const [findings, setFindings] = useState([]);
  const [series, setSeries] = useState({});
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(null);

  const setParam = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    try {
      const q = window.range ? { range: window.range } : { from: window.from, to: window.to };
      const [d, f, cpu, storage, battery] = await Promise.all([
        api.get(`/devices/${id}`),
        api.get(`/devices/${id}/findings`, { params: { status: 'all' } }),
        api.get(`/devices/${id}/timeseries`, { params: { kind: 'cpu', ...q } }),
        api.get(`/devices/${id}/timeseries`, { params: { kind: 'storage', ...q } }),
        api.get(`/devices/${id}/timeseries`, { params: { kind: 'battery', ...q } }),
      ]);
      setData(d.data);
      setFindings(f.data.findings);
      setSeries({ cpu: cpu.data, storage: storage.data, battery: battery.data });
      setUpdated(new Date());
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  }, [id, window]);

  useEffect(() => {
    setSeries({});
    load();
  }, [load]);

  // Live devices refresh every minute (the agent's upload interval).
  useEffect(() => {
    if (!data || data.device.isSimulated) return undefined;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [data, load]);

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Spinner label="Loading device" />;

  const { device, summary } = data;
  const active = findings.filter((f) => f.status === 'active');
  const worst = ['Urgent', 'Attention', 'Watch', 'Information'].find((s) => active.some((f) => f.severity === s));

  return (
    <>
      {device.isSimulated && (
        <div className="rounded-lg border-[1.5px] border-dashed border-[#5b3fa0] bg-sim-soft px-5 py-3 text-sm font-semibold text-[#3b2477]">
          Simulated device. Every number on this page is synthetic data from the seeded simulator, not a measurement.
        </div>
      )}
      <Link to="/" className="text-sm font-semibold">
        ← All devices
      </Link>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-grow flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 bg-gradient-to-r from-ink to-brand bg-clip-text text-4xl font-semibold tracking-tight text-transparent">{device.name}</h1>
            <DataLabel simulated={device.isSimulated} />
            {worst ? <Severity level={worst} /> : <Severity level="Normal">No findings</Severity>}
          </div>
          <div className="text-muted">
            {!device.isSimulated && <Live iso={device.lastSeen} />}
            {[device.model, device.bios && `BIOS ${device.bios}`, device.os].filter(Boolean).join(' · ') || 'Model not set (add it in Settings)'} · last seen{' '}
            {timeAgo(device.lastSeen)}
          </div>
        </div>
        {!device.isSimulated && (
          <Link to={`/devices/${device.id}/diagnose`} className="press inline-flex min-h-11 items-center rounded-lg bg-brand px-5 font-semibold text-white no-underline hover:bg-brand-dark hover:text-white">
            Why is it slow? Diagnose
          </Link>
        )}
      </div>

      {/* tabs */}
      <nav aria-label="Device sections" className="-mx-1 flex gap-1 overflow-x-auto rounded-xl border border-line bg-panel/80 p-1 backdrop-blur-sm">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setParam({ tab: k === 'overview' ? null : k })}
            aria-current={tab === k ? 'page' : undefined}
            className={`min-h-10 shrink-0 rounded-lg px-4 text-sm transition-all duration-200 ${tab === k ? 'bg-ink font-semibold text-white shadow-md' : 'text-muted hover:bg-soft hover:text-ink'}`}
          >
            {label}
            {k === 'findings' && active.length > 0 && <span className="ml-2 rounded-full bg-[#ffe4d6] px-1.5 text-xs font-bold text-[#9a3412]">{active.length}</span>}
          </button>
        ))}
      </nav>

      {/* date range */}
      {!['settings', 'findings', 'diagnoses'].includes(tab) && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-panel/80 p-1 shadow-sm" role="group" aria-label="Date range">
            {RANGES.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setParam({ range: k === '7d' ? null : k, from: null, to: null })}
                aria-pressed={range === k}
                className={`min-h-9 rounded-md px-3 text-sm ${range === k ? 'bg-brand font-semibold text-white' : 'text-muted hover:text-ink'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <form
            className="flex flex-wrap items-center gap-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (f.get('from') && f.get('to')) setParam({ range: null, from: f.get('from'), to: `${f.get('to')}T23:59:59Z` });
            }}
          >
            <label className="flex items-center gap-1.5">
              <span className="text-muted">From</span>
              <input name="from" type="date" defaultValue={params.get('from')?.slice(0, 10)} className="min-h-9 rounded-md border border-line bg-panel px-2" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted">to</span>
              <input name="to" type="date" defaultValue={params.get('to')?.slice(0, 10)} className="min-h-9 rounded-md border border-line bg-panel px-2" />
            </label>
            <Button type="submit" variant="secondary" className="!min-h-9 !px-3 text-sm">
              Apply
            </Button>
          </form>
          <div className="flex-grow" />
          <div className="flex items-center gap-2 text-xs text-muted">
            {(() => {
              const s = series[tab === 'storage' ? 'storage' : tab === 'battery' ? 'battery' : 'cpu'];
              return s ? (
                <span>
                  {new Date(s.from).toLocaleDateString()} – {new Date(s.to).toLocaleDateString()} · {s.sampleCount.toLocaleString()} readings
                </span>
              ) : null;
            })()}
            {updated && <span>· updated {updated.toLocaleTimeString()}</span>}
            <Button variant="ghost" className="!min-h-9 !px-3 text-sm" onClick={load}>
              Refresh
            </Button>
          </div>
        </div>
      )}
      {error && <Alert>{error}</Alert>}

      <div key={tab} className="page-enter flex flex-col gap-6">
        {tab === 'overview' && <Overview device={device} summary={summary} series={series} findings={findings} onTab={(k) => setParam({ tab: k })} />}
        {tab === 'performance' && <Performance series={series} summary={summary} />}
        {tab === 'storage' && <StorageTab series={series} summary={summary} />}
        {tab === 'battery' && <BatteryTab device={device} summary={summary} series={series} range={range} />}
        {tab === 'findings' && <FindingsTab findings={findings} />}
        {tab === 'diagnoses' && <DiagnosesTab device={device} />}
        {tab === 'raw' && <RawTab device={device} window={series.cpu ? { from: series.cpu.from, to: series.cpu.to } : {}} />}
        {tab === 'settings' && <DeviceSettings device={device} onSaved={(d) => setData((cur) => ({ ...cur, device: { ...cur.device, ...d } }))} />}
      </div>
    </>
  );
}
