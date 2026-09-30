import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, errorText } from '../api.js';
import { BatteryChart } from '../BatteryChart.jsx';
import { Alert, Card, DataLabel, Live, Severity, Spinner, Stat, Status, timeAgo } from '../ui.jsx';

const fmtRange = (f) => {
  if (f.monthsHigh === null) return `at least ${f.monthsLow} months`;
  if (Math.round(f.monthsLow) === Math.round(f.monthsHigh)) return `about ${Math.round(f.monthsLow)} months`;
  return `roughly ${f.monthsLow} to ${f.monthsHigh} months`;
};

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
        <span className="text-[13px] text-muted">
          {f.status === 'cleared' ? 'cleared' : 'first seen'} {timeAgo(f.status === 'cleared' ? f.lastSeen : f.firstSeen)}
        </span>
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

export default function DeviceDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [findings, setFindings] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [d, f] = await Promise.all([api.get(`/devices/${id}`), api.get(`/devices/${id}/findings`, { params: { status: 'all' } })]);
        if (!alive) return;
        setData(d.data);
        setFindings(f.data.findings);
      } catch (err) {
        if (alive) setError(errorText(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner label="Loading device" />;

  const { device, summary } = data;
  const { battery, latest } = summary;
  const cpu = latest.cpu?.values ?? {};
  const st = latest.storage?.values ?? {};
  // Pending findings are never shown (they need a second detection first).
  const active = findings.filter((f) => f.status === 'active');
  const cleared = findings.filter((f) => f.status === 'cleared');
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
            <h1 className="m-0 text-3xl font-semibold tracking-tight">{device.name}</h1>
            <DataLabel simulated={device.isSimulated} />
            {worst ? <Severity level={worst} /> : <Severity level="Normal">No findings</Severity>}
          </div>
          <div className="text-muted">
            {!device.isSimulated && <Live iso={device.lastSeen} />}
            {[device.model, device.bios && `BIOS ${device.bios}`, device.os].filter(Boolean).join(' · ') || 'Model not reported'} · last seen{' '}
            {timeAgo(device.lastSeen)}
          </div>
        </div>
        {device.isSimulated ? (
          <span className="text-sm text-muted">Diagnose needs a real agent</span>
        ) : (
          <Link to={`/devices/${device.id}/diagnose`} className="press inline-flex min-h-11 items-center rounded-lg bg-brand px-5 font-semibold text-white no-underline hover:bg-brand-dark hover:text-white">
            Why is it slow? Diagnose
          </Link>
        )}
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
              {battery.points} of {battery.needsPoints} days of readings, over {battery.spanDays} of {battery.needsSpanDays} days. A trend and
              forecast appear after that; until then no forecast is shown.
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
          {latest.battery && latest.battery.values.cycles == null && <div className="text-[13px] text-muted">Charge cycles: Not available on this device</div>}
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
            <Stat label="Wear (rated endurance used)" value={st.percentageUsed} unit="%" hint={latest.storage ? undefined : '—'} />
            <Stat label="SMART self-check" value={st.smartPassed == null ? null : st.smartPassed ? 'Passed' : 'Failed'} hint={latest.storage ? undefined : '—'} />
          </div>
        </Card>
      </div>

      <Card title="Temperature" right={<Status>{thermalStatus[summary.thermal.status] ?? summary.thermal.status}</Status>}>
        {cpu.cpuTempC != null ? (
          <Stat label="CPU temperature" value={cpu.cpuTempC} unit=" °C" />
        ) : (
          <p className="m-0 max-w-3xl text-sm text-muted">
            {latest.cpu ? 'Temperature is not available on this device. ' : ''}DevicePulse does not guess. Without temperature it watches for the processor
            slowing down under sustained heavy load, comparing like with like (same load band, same power source).
          </p>
        )}
      </Card>

      {summary.batteryHistory.length > 1 && (
        <Card title="Battery health over time" right={<DataLabel simulated={device.isSimulated} />}>
          <BatteryChart history={summary.batteryHistory} battery={battery} />
          {battery.forecast && !battery.forecast.alreadyBelowThreshold && (
            <p className="m-0 text-[13px] text-muted">
              Shaded: forecast range (about 95%). It is a range of possibilities, not a date the battery will stop working.
            </p>
          )}
        </Card>
      )}

      <Card title="Findings">
        {active.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-[#c9c6ba] p-7 text-center">
            <div className="font-semibold">No findings</div>
            <div className="max-w-2xl text-sm text-muted">
              A finding is shown only after two checks in a row agree, and it clears after three normal checks.
            </div>
          </div>
        ) : (
          active.map((f) => <Finding key={f.id} f={f} />)
        )}
        {cleared.length > 0 && (
          <details className="border-t border-soft pt-3">
            <summary className="min-h-8 cursor-pointer text-sm font-semibold">Past findings ({cleared.length})</summary>
            {cleared.map((f) => (
              <Finding key={f.id} f={f} />
            ))}
          </details>
        )}
      </Card>
    </>
  );
}
