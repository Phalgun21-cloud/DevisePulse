import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, apiOrigin, errorText } from '../api.js';
import { Alert, Button, DataLabel, Live, Severity, Spinner, Status, timeAgo } from '../ui.jsx';
import { CountUp } from '../fx.jsx';

function AddDevice({ onDone }) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      const { data } = await api.post('/devices', { name });
      setCreated(data);
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (created) {
    const command = `python agent\\agent.py --server ${apiOrigin()} --token ${created.deviceToken}`;
    return (
      <div className="flex flex-col gap-3 rounded-xl border-2 border-brand bg-panel p-6">
        <h2 className="m-0 text-lg font-semibold">“{created.name}” added. Start the agent on that laptop:</h2>
        <p className="m-0 text-sm text-muted">
          This token is shown <strong>only once</strong>. DevicePulse stores just a hash of it. Run from the DevicePulse folder
          after <code className="font-mono">pip install -r agent\requirements.txt</code>.
        </p>
        <pre className="m-0 overflow-x-auto rounded-lg bg-ink p-4 font-mono text-sm text-ground">{command}</pre>
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? 'Copied' : 'Copy command'}
          </Button>
          <Button variant="secondary" onClick={() => setCreated(null)}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel p-6">
      <label className="flex min-w-60 flex-grow flex-col gap-1.5 text-sm font-medium">
        Device name
        <input
          className="min-h-11 rounded-lg border border-line px-3 text-[15px]"
          required
          maxLength={80}
          placeholder="e.g. Library laptop 4"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <Button type="submit">Create device</Button>
      {error && <div className="w-full"><Alert>{error}</Alert></div>}
    </form>
  );
}

export default function Devices() {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/devices');
      setDevices(data.devices);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function seed() {
    setSeeding(true);
    setError('');
    try {
      await api.post('/demo/seed');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSeeding(false);
    }
  }

  const count = (pred) => (devices ?? []).filter(pred).length;
  const hasDemo = (devices ?? []).some((d) => d.isSimulated);

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-grow flex-col gap-1.5">
          <h1 className="m-0 bg-gradient-to-r from-ink to-brand bg-clip-text text-4xl font-semibold tracking-tight text-transparent">Devices</h1>
          <p className="m-0 text-muted">Elevated-risk findings with evidence. A finding appears only after two checks agree.</p>
        </div>
        {!hasDemo && (
          <Button variant="secondary" onClick={seed} disabled={seeding}>
            {seeding ? 'Loading demo devices…' : 'Load demo devices (simulated)'}
          </Button>
        )}
        <Button onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add device'}</Button>
      </div>

      {error && <Alert>{error}</Alert>}
      {adding && <AddDevice onDone={load} />}

      {devices === null ? (
        <Spinner label="Loading devices" />
      ) : devices.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border-[1.5px] border-dashed border-[#c9c6ba] p-10 text-center">
          <div className="text-lg font-semibold">No devices yet</div>
          <p className="m-0 max-w-xl text-muted">
            Add a laptop and run the agent on it, or load the simulated demo devices to see what findings look like.
          </p>
        </div>
      ) : (
        <>
          <div className="stagger grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              ['Devices', devices.length, `${count((d) => !d.isSimulated)} real, ${count((d) => d.isSimulated)} simulated`],
              ['Urgent', count((d) => d.worstSeverity === 'Urgent'), 'back up now'],
              ['Attention', count((d) => d.worstSeverity === 'Attention'), 'plan action'],
              ['Watch', count((d) => d.worstSeverity === 'Watch'), 'keep an eye on'],
            ].map(([label, n, hint]) => (
              <div key={label} className="spot flex flex-col gap-1 rounded-xl border border-line bg-panel/90 p-5 backdrop-blur-sm">
                <div className="text-[13px] text-muted">{label}</div>
                <div className="font-mono text-4xl font-semibold">
                  <CountUp value={n} />
                </div>
                <div className="text-[13px] text-muted">{hint}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full min-w-[720px] border-collapse text-left text-[15px]">
              <thead className="bg-soft text-[13px] text-muted">
                <tr>
                  <th className="px-6 py-3 font-semibold">Device</th>
                  <th className="px-3 py-3 font-semibold">Model</th>
                  <th className="px-3 py-3 font-semibold">Data</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-3 py-3 font-semibold">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-t border-soft transition-colors hover:bg-brand-soft/60">
                    <td className="px-6 py-4">
                      {!d.isSimulated && <Live iso={d.lastSeen} />}
                      <Link to={`/devices/${d.id}`} className="font-semibold">
                        {d.name}
                      </Link>
                    </td>
                    <td className="px-3 py-4 text-muted">{[d.model, d.bios && `BIOS ${d.bios}`].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-4">
                      <DataLabel simulated={d.isSimulated} />
                    </td>
                    <td className="px-3 py-4">
                      {d.worstSeverity === 'Normal' ? (
                        d.lastSeen ? <Severity level="Normal">No findings</Severity> : <Status>Waiting for agent</Status>
                      ) : (
                        <Severity level={d.worstSeverity} />
                      )}
                    </td>
                    <td className="px-3 py-4 font-mono text-sm text-muted">{d.isSimulated ? 'synthetic' : timeAgo(d.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="flex items-center gap-3 rounded-xl bg-brand-soft px-5 py-4 text-sm text-[#0b3f3c]">
        DevicePulse reports elevated risk with a confidence label. It never predicts an exact failure date.
      </div>
    </>
  );
}
