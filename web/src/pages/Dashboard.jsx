import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, errorText } from '../api.js';
import { CountUp } from '../fx.jsx';
import { fmtWhen } from '../charts.jsx';
import { Alert, Card, DataLabel, Live, Severity, Spinner, timeAgo } from '../ui.jsx';

const SEV = ['Urgent', 'Attention', 'Watch', 'Information'];
const SEV_COLOR = { Urgent: '#ef4444', Attention: '#fb923c', Watch: '#facc15', Information: '#60a5fa' };
const SIGNALS = [
  ['cpu', 'CPU load'],
  ['memory', 'Memory'],
  ['cpuSpeed', 'CPU speed'],
  ['temperature', 'Temperature'],
  ['battery', 'Battery health'],
  ['diskTest', 'Disk test'],
  ['freeSpace', 'Free space'],
  ['smart', 'SMART'],
];
const online = (d) => !d.isSimulated && d.lastSeen && Date.now() - Date.parse(d.lastSeen) < 5 * 60_000;
const v = (x, unit = '', digits = 1) => (x === null || x === undefined ? null : `${Number(x).toFixed(digits)}${unit}`);

function Kpi({ label, value, sub, accent }) {
  return (
    <div className="spot kpi-glow flex flex-col gap-1 rounded-2xl border border-line bg-panel/90 p-5 backdrop-blur-sm">
      <div className="text-[12px] font-semibold tracking-wider text-muted uppercase">{label}</div>
      <div className="font-mono text-4xl font-semibold" style={accent ? { color: accent } : undefined}>
        <CountUp value={value} />
      </div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-ground/60 px-3 py-2">
      <div className="text-[11px] tracking-wide text-muted uppercase">{label}</div>
      <div className={`font-mono text-[15px] font-semibold ${value === null ? 'text-muted' : ''}`}>{value ?? 'n/a'}</div>
    </div>
  );
}

function DeviceCard({ d }) {
  const c = d.latest.cpu ?? {};
  const s = d.latest.storage ?? {};
  const b = d.latest.battery ?? {};
  const covered = SIGNALS.filter(([k]) => d.coverage[k]).length;
  return (
    <Link to={`/devices/${d.id}`} className="spot group flex flex-col gap-4 rounded-2xl border border-line bg-panel/90 p-5 text-ink no-underline backdrop-blur-sm hover:text-ink">
      <div className="flex items-start gap-3">
        <div className="flex flex-grow flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            {online(d) && <Live iso={d.lastSeen} />}
            <span className="text-lg font-semibold group-hover:text-brand-dark">{d.name}</span>
          </div>
          <div className="text-[13px] text-muted">{[d.model, d.bios && `BIOS ${d.bios}`].filter(Boolean).join(' · ') || 'Model not set'}</div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <DataLabel simulated={d.isSimulated} />
          {d.worstSeverity === 'Normal' ? <Severity level="Normal">{d.lastSeen ? 'Healthy' : 'Waiting'}</Severity> : <Severity level={d.worstSeverity} />}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Metric label="CPU" value={v(c.cpuLoadPct, '%')} />
        <Metric label="Memory" value={v(c.memUsedPct, '%')} />
        <Metric label="Speed" value={v(c.cpuFreqRatio, '×', 2)} />
        <Metric label="Battery" value={v(b.healthPct, '%')} />
        <Metric label="Disk test" value={v(s.ioProbeMs, ' ms')} />
        <Metric label="Free" value={v(s.freeSpacePct, '%')} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-muted">
          <span>Monitoring coverage</span>
          <span className="font-mono">
            {covered}/{SIGNALS.length} signals
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SIGNALS.map(([k, label]) => (
            <span
              key={k}
              title={d.coverage[k] ? `${label}: measured` : `${label}: not available on this device`}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${d.coverage[k] ? 'bg-brand-soft text-brand-dark' : 'bg-soft text-muted line-through decoration-muted/50'}`}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-muted">
        <span>
          <span className="font-mono text-ink">{(d.readings.cpu + d.readings.storage + d.readings.battery).toLocaleString()}</span> readings
        </span>
        <span>since {d.monitoredSince ? new Date(d.monitoredSince).toLocaleDateString() : '—'}</span>
        <span>{d.isSimulated ? 'synthetic' : `seen ${timeAgo(d.lastSeen)}`}</span>
      </div>

      {d.findings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {d.findings.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-sm">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEV_COLOR[f.severity] }} aria-hidden="true" />
              <span className="font-medium">{f.severity}:</span>
              <span className="truncate text-muted">{f.title}</span>
            </li>
          ))}
        </ul>
      )}
    </Link>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () =>
      api
        .get('/overview')
        .then((r) => setData(r.data))
        .catch((err) => setError(errorText(err)));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Spinner label="Loading dashboard" />;

  const { totals, devices, findings } = data;
  const onlineCount = devices.filter(online).length;
  const sevTotal = SEV.reduce((a, s) => a + totals.bySeverity[s], 0);

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-grow flex-col gap-1.5">
          <div className="text-xs font-semibold tracking-[0.2em] text-brand uppercase">Fleet health</div>
          <h1 className="m-0 bg-gradient-to-r from-ink via-brand-dark to-sim bg-clip-text text-4xl font-semibold tracking-tight text-transparent">Dashboard</h1>
          <p className="m-0 text-muted">Every device, its latest readings, what is measured on it, and what needs attention.</p>
        </div>
        <Link to="/monitoring" className="text-sm font-semibold">
          How monitoring works →
        </Link>
        <Link to="/devices" className="press inline-flex min-h-11 items-center rounded-lg bg-brand px-5 font-semibold text-[#04201d] no-underline hover:bg-brand-dark hover:text-[#04201d]">
          Manage devices
        </Link>
      </div>

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Devices" value={totals.devices} sub={`${totals.real} real · ${totals.simulated} simulated`} />
        <Kpi label="Reporting now" value={onlineCount} sub="real devices seen in the last 5 min" accent="#34d399" />
        <Kpi label="Active findings" value={totals.activeFindings} sub={totals.activeFindings ? 'see the list below' : 'nothing to act on'} accent={totals.activeFindings ? '#fb923c' : undefined} />
        <Kpi label="Readings stored" value={totals.readings} sub="CPU, storage and battery samples" />
      </div>

      <Card title="Findings by severity" right={<span className="text-xs text-muted">{sevTotal} active</span>}>
        {sevTotal === 0 ? (
          <div className="text-sm text-muted">No active findings on any device.</div>
        ) : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-soft" role="img" aria-label={SEV.map((s) => `${s} ${totals.bySeverity[s]}`).join(', ')}>
              {SEV.map((s) => (totals.bySeverity[s] ? <div key={s} style={{ width: `${(totals.bySeverity[s] / sevTotal) * 100}%`, background: SEV_COLOR[s] }} /> : null))}
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              {SEV.map((s) => (
                <span key={s} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SEV_COLOR[s] }} aria-hidden="true" />
                  {s} <span className="font-mono font-semibold">{totals.bySeverity[s]}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </Card>

      {devices.length === 0 ? (
        <Card>
          <div className="py-6 text-center">
            <div className="text-lg font-semibold">No devices yet</div>
            <p className="text-muted">
              <Link to="/devices">Add a device</Link> and run the agent on it, or load the simulated demo devices.
            </p>
          </div>
        </Card>
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {devices.map((d) => (
            <DeviceCard key={d.id} d={d} />
          ))}
        </div>
      )}

      {findings.length > 0 && (
        <Card title="All active findings">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead className="text-left text-[12px] tracking-wide text-muted uppercase">
                <tr>
                  <th className="py-2 font-semibold">Severity</th>
                  <th className="py-2 font-semibold">Device</th>
                  <th className="py-2 font-semibold">Finding</th>
                  <th className="py-2 font-semibold">Data</th>
                  <th className="py-2 font-semibold">First seen</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.id} className="border-t border-line">
                    <td className="py-2.5">
                      <Severity level={f.severity} />
                    </td>
                    <td className="py-2.5">
                      <Link to={`/devices/${f.deviceId}?tab=findings`} className="font-semibold">
                        {f.deviceName}
                      </Link>
                    </td>
                    <td className="py-2.5">{f.title}</td>
                    <td className="py-2.5">
                      <DataLabel simulated={f.data === 'Simulated'} />
                    </td>
                    <td className="py-2.5 font-mono text-xs text-muted">{fmtWhen(f.firstSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
