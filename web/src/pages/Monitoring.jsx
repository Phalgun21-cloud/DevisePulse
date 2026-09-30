import { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { Alert, Card, DataLabel, Severity, Spinner } from '../ui.jsx';

const every = (s) => (s >= 3600 ? `every ${s / 3600} h` : s >= 60 ? `every ${s / 60} min` : `every ${s} s`);

function Rules({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead className="text-left text-[12px] tracking-wide text-muted uppercase">
          <tr>
            <th className="py-2 font-semibold">Check</th>
            <th className="py-2 font-semibold">Rule (live values from the server)</th>
            <th className="py-2 font-semibold">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([check, rule, sev]) => (
            <tr key={check + rule} className="border-t border-line align-top">
              <td className="py-2.5 pr-4 font-medium">{check}</td>
              <td className="py-2.5 pr-4 text-muted">{rule}</td>
              <td className="py-2.5">{sev ? <Severity level={sev} /> : <span className="text-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Monitoring() {
  const [m, setM] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get('/monitoring')
      .then((r) => setM(r.data))
      .catch((err) => setError(errorText(err)));
  }, []);
  if (error) return <Alert>{error}</Alert>;
  if (!m) return <Spinner label="Loading" />;
  const { cadence: c, settings: s } = m;

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-semibold tracking-[0.2em] text-brand uppercase">Transparency</div>
        <h1 className="m-0 text-4xl font-semibold tracking-tight">How monitoring works</h1>
        <p className="m-0 max-w-3xl text-muted">
          Every finding comes from a written, tested rule applied to measured numbers. The thresholds below are read live from the server, so this page
          always matches what the detectors actually do.
        </p>
      </div>

      <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ['1. Measure', 'A small agent on each laptop reads numbers only: CPU, memory, processor speed, battery capacity, a timed disk test, free space and SMART when available.'],
          ['2. Upload', 'Readings go to the API with a per-device token. If the network drops, the agent keeps them and sends them later, in order, without duplicates.'],
          ['3. Detect', 'Detectors compare each device with its own history (baselines) and with fixed limits. Missing sensors are skipped, never treated as zero.'],
          ['4. Confirm', `A finding shows only after ${s.findings.confirmDetections} checks in a row agree, and clears after ${s.findings.clearAfterNormal} normal checks, so one-off blips never alarm.`],
        ].map(([t, body]) => (
          <div key={t} className="spot rounded-2xl border border-line bg-panel/90 p-5">
            <div className="mb-2 font-semibold text-brand-dark">{t}</div>
            <p className="m-0 text-sm leading-relaxed text-muted">{body}</p>
          </div>
        ))}
      </div>

      <Card title="What is collected, and how often">
        <Rules
          rows={[
            ['CPU load, memory, swap, processor speed, power source', every(c.cpuSeconds), null],
            ['Battery design and full-charge capacity, charge %', every(c.batterySeconds), null],
            ['Timed 8 MB write + fsync + read, free space, SMART (if smartctl is installed)', every(c.storageSeconds), null],
            ['Check for a "why is it slow?" request', `every ${c.commandPollSeconds} s; the sample itself lasts ${c.diagnoseSeconds} s`, null],
          ]}
        />
        <p className="m-0 text-sm text-muted">
          Never collected: file contents, browsing data, screen content, window titles, command lines or anything personal. Diagnoses record process{' '}
          <em>names</em> only.
        </p>
      </Card>

      <Card title="Battery">
        <Rules
          rows={[
            ['Health', `full-charge ÷ design capacity, one median point per day`, null],
            ['Wear', `health below ${s.battery.watchBelowPct}%`, 'Watch'],
            ['Serious wear', `health below ${s.battery.attentionBelowPct}%, or the last ${s.battery.accelerationWindowDays} days declining ${s.battery.accelerationRatio}× faster than before`, 'Attention'],
            ['Forecast', `needs ${s.battery.minPoints} days of readings over ${s.battery.minSpanDays} days; a range (slope ± ${s.battery.forecastSeMultiplier} standard errors) to ${s.battery.replacementThresholdPct}%, never a date`, null],
          ]}
        />
      </Card>

      <Card title="Storage">
        <Rules
          rows={[
            ['SMART critical warning, spare blocks at minimum, or self-check failed', 'hard drive-health warning', 'Urgent'],
            ['Wear', `rated write endurance used ≥ ${s.storage.wearAttentionPct}%`, 'Attention'],
            ['Errors', `media errors / reallocated sectors rising two ${s.storage.errorWindowDays}-day periods in a row (one rise: Watch); pending sectors > 0`, 'Attention'],
            ['Slower than usual', `median of the last ${s.storage.recentHours} h ≥ ${s.storage.slowRatio}× the device's first ${s.storage.baselineDays} days; alone it stays Watch`, 'Watch'],
            ['Slower and nearly full', `as above, with free space below ${s.storage.freeWatchBelowPct}% or a SMART warning`, 'Attention'],
            ['Free space', `below ${s.storage.freeInfoBelowPct}%: Information; below ${s.storage.freeWatchBelowPct}%: Watch`, 'Information'],
          ]}
        />
      </Card>

      <Card title="Heat and speed (thermal)">
        <Rules
          rows={[
            ['Hotter at the same load', `≥ ${s.thermal.tempRiseWatchC} °C above the first ${s.thermal.baselineDays} days, compared within ${s.thermal.bucketWidthPct}-point load bands and the same power source`, 'Watch'],
            ['Hotter and slower', `as above, plus processor speed ≥ ${s.thermal.freqDropWithHeatPct}% lower at load ≥ ${s.thermal.highLoadFromPct}%`, 'Attention'],
            ['No temperature sensor', `processor speed ≥ ${s.thermal.freqDropAlonePct}% lower under sustained load > ${s.thermal.sustainedLoadPct}% (one signal: never above Watch)`, 'Watch'],
            ['How often', `at most every ${s.thermal.evaluateEveryMinutes} minutes of data, not on every one-minute reading`, null],
          ]}
        />
      </Card>

      <Card title="Why is it slow? (on-demand diagnosis)">
        <Rules
          rows={[
            ['Processor overloaded', `CPU ≥ ${s.diagnose.cpuPct}%, names the busiest process (grouped by name)`, null],
            ['Short of memory', `memory ≥ ${s.diagnose.memUsedPct}% or paging activity`, null],
            ['Disk overloaded', `busy > ${s.diagnose.diskBusyPct}% or latency ≥ ${s.diagnose.diskLatencyRatio}× the device's usual`, null],
            ['Slowing itself down', `speed < ${s.diagnose.throttleFreqRatio}× base while CPU ≥ ${s.diagnose.throttleMinLoadPct}%`, null],
          ]}
        />
      </Card>

      <Card title="Severity levels and data labels">
        <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          {[
            ['Information', 'Worth knowing, no action needed yet.'],
            ['Watch', 'One signal is off. Keep an eye on it.'],
            ['Attention', 'Two signals agree, or a hard drive warning. Plan action.'],
            ['Urgent', 'The drive itself reports a critical problem. Back up now.'],
          ].map(([sev, body]) => (
            <div key={sev} className="flex items-center gap-3">
              <Severity level={sev} />
              <span className="text-muted">{body}</span>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <DataLabel simulated={false} />
            <span className="text-muted">measured on a real laptop by the agent</span>
          </div>
          <div className="flex items-center gap-3">
            <DataLabel simulated />
            <span className="text-muted">synthetic data from the seeded simulator</span>
          </div>
        </div>
      </Card>
    </>
  );
}
