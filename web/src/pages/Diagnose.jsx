import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, errorText } from '../api.js';
import { Alert, Button, Card, DataLabel, Severity, Spinner, timeAgo } from '../ui.jsx';

const ruleTitle = {
  cpu_saturated: 'Processor overloaded',
  memory_pressure: 'Running short of memory',
  disk_saturated: 'Disk overloaded',
  cpu_throttled: 'Processor slowing itself down',
};
const fmtMb = (mb) => `${Math.round(mb).toLocaleString()} MB`;

function Result({ req }) {
  const { result, sample } = req;
  const lines = result.explanation.split('\n').slice(1);
  return (
    <>
      {result.causes.length === 0 ? (
        <Card>
          <div className="text-lg font-semibold">No clear cause</div>
          <p className="m-0 text-muted">{result.explanation}</p>
        </Card>
      ) : (
        result.causes.map((c, i) => (
          <Card key={c.rule}>
            <div className="flex items-start gap-5">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-ink font-mono text-2xl font-bold text-white">{c.rank}</div>
              <div className="flex flex-col gap-2">
                <div className="text-xl font-semibold">
                  {ruleTitle[c.rule] ?? c.rule}
                  {c.process ? `: ${c.process}` : ''}
                </div>
                <p className="m-0 leading-relaxed">{(lines[i] ?? '').replace(/^\d+\.\s*/, '')}</p>
              </div>
            </div>
          </Card>
        ))
      )}

      {sample && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Top processes (grouped by name)">
            <table className="w-full border-collapse font-mono text-sm">
              <thead className="text-left font-sans text-[13px] text-muted">
                <tr>
                  <th className="py-1 font-semibold">Name</th>
                  <th className="py-1 text-right font-semibold">CPU</th>
                  <th className="py-1 text-right font-semibold">Memory</th>
                </tr>
              </thead>
              <tbody>
                {sample.topProcesses.map((p) => (
                  <tr key={p.name}>
                    <td className="py-1">
                      {p.name}
                      {p.count > 1 && ` ×${p.count}`}
                    </td>
                    <td className="py-1 text-right">{p.cpuPct}%</td>
                    <td className="py-1 text-right">{fmtMb(p.memMb)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-xs text-muted">Process names only. DevicePulse never reads command lines, files or window titles.</div>
          </Card>
          <Card title="All readings in this sample">
            {[
              ['CPU busy', sample.cpuPct, '%'],
              ['Memory used', sample.memUsedPct, '%'],
              ['Disk busy', sample.diskBusyPct, '%'],
              ['Disk latency', sample.diskLatencyMs, ' ms'],
              ['Speed vs base clock', sample.cpuFreqRatio, '×'],
              ['Swap activity', sample.swapActivityBytes === null ? null : Math.round(sample.swapActivityBytes / 1048576), ' MB'],
            ].map(([label, v, unit]) => (
              <div key={label} className="flex gap-2 text-sm">
                <div className="flex-grow">{label}</div>
                {v === null || v === undefined ? <div className="text-muted">Not available on this device</div> : <div className="font-mono">{v}{unit}</div>}
              </div>
            ))}
            {result.skippedRules.length > 0 && <div className="text-xs text-muted">Skipped for missing readings: {result.skippedRules.join(', ')}</div>}
          </Card>
        </div>
      )}
    </>
  );
}

export default function Diagnose() {
  const { id } = useParams();
  const [device, setDevice] = useState(null);
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const timer = useRef(null);

  const loadHistory = useCallback(async () => {
    const { data } = await api.get(`/devices/${id}/diagnose`);
    setHistory(data.requests);
    return data.requests;
  }, [id]);

  const poll = useCallback(
    (reqId) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        try {
          const { data } = await api.get(`/devices/${id}/diagnose/${reqId}`);
          setCurrent(data);
          if (data.status === 'pending' || data.status === 'running') poll(reqId);
          else loadHistory();
        } catch (err) {
          setError(errorText(err));
        }
      }, 2500);
    },
    [id, loadHistory],
  );

  useEffect(() => {
    (async () => {
      try {
        const [{ data: d }, reqs] = await Promise.all([api.get(`/devices/${id}`), loadHistory()]);
        setDevice(d.device);
        const open = reqs.find((r) => r.status === 'pending' || r.status === 'running');
        const shown = open ?? reqs.find((r) => r.status === 'done');
        if (shown) setCurrent(shown);
        if (open) poll(open.id);
      } catch (err) {
        setError(errorText(err));
      }
    })();
    return () => clearTimeout(timer.current);
  }, [id, loadHistory, poll]);

  async function start() {
    setError('');
    try {
      const { data } = await api.post(`/devices/${id}/diagnose`);
      setCurrent(data);
      poll(data.id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!device && !error) return <Spinner label="Loading" />;
  const busy = current && (current.status === 'pending' || current.status === 'running');

  return (
    <>
      <Link to={`/devices/${id}`} className="text-sm font-semibold">
        ← {device?.name ?? 'Device'}
      </Link>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-grow flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="m-0 text-3xl font-semibold tracking-tight">Why is it slow?</h1>
            {device && <DataLabel simulated={device.isSimulated} />}
          </div>
          <div className="text-muted">Asks the agent for one 10-second sample of CPU, memory, disk and the top processes.</div>
        </div>
        <Button onClick={start} disabled={busy || device?.isSimulated}>
          {busy ? 'Diagnosing…' : current ? 'Run again' : 'Diagnose now'}
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}

      {current && (
        <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
          <Severity level={current.status === 'pending' ? undefined : 'Normal'}>Requested</Severity>
          <span aria-hidden="true">→</span>
          <Severity level={current.status === 'running' ? undefined : current.status === 'pending' ? 'x' : 'Normal'}>
            {current.status === 'pending' ? 'Waiting for the agent (checks every 15 s)' : 'Agent sampling (10 s)'}
          </Severity>
          <span aria-hidden="true">→</span>
          {current.status === 'done' ? (
            <Severity level="Normal">Done {timeAgo(current.completedAt)}</Severity>
          ) : current.status === 'expired' ? (
            <Severity level="Attention">Expired: the agent did not answer within 10 minutes. Is it running?</Severity>
          ) : (
            <span className="text-muted">Result</span>
          )}
        </div>
      )}

      {current?.status === 'done' && <Result req={current} />}

      {history.filter((r) => r.status === 'done').length > 1 && (
        <Card title="Earlier diagnoses">
          {history
            .filter((r) => r.status === 'done' && r.id !== current?.id)
            .map((r) => (
              <button key={r.id} className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-left hover:bg-soft" onClick={() => setCurrent(r)}>
                <span className="font-mono text-sm text-muted">{new Date(r.completedAt).toLocaleString()}</span>
                <span>{r.result.causes.length ? r.result.causes.map((c) => ruleTitle[c.rule]).join(', ') : 'No clear cause'}</span>
              </button>
            ))}
        </Card>
      )}
    </>
  );
}
