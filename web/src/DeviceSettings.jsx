import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorText } from './api.js';
import { useToast } from './Layout.jsx';
import { Button, Card } from './ui.jsx';

// Rename a device, or delete it (with its readings and findings) after an explicit confirmation.
export function DeviceSettings({ device, onSaved }) {
  const toast = useToast();
  const navigate = useNavigate();
  const dialog = useRef(null);
  const [name, setName] = useState(device.name);
  const [model, setModel] = useState(device.model ?? '');
  const [bios, setBios] = useState(device.bios ?? '');
  const [busy, setBusy] = useState(false);
  const input = 'min-h-11 rounded-lg border border-line bg-panel px-3 text-[15px]';

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.patch(`/devices/${device.id}`, { name, model: model || null, bios: bios || null });
      onSaved(data.device);
      toast('Device saved');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.delete(`/devices/${device.id}`);
      dialog.current?.close();
      toast(`${device.name} deleted`);
      navigate('/');
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
    }
  }

  return (
    <Card title="Device settings">
      <form onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Name
          <input className={input} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Model
          <input className={input} maxLength={120} placeholder="e.g. Dell Inspiron 15 5510" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          BIOS version
          <input className={input} maxLength={120} placeholder="e.g. 2.33.1" value={bios} onChange={(e) => setBios(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-3 sm:col-span-3">
          <Button type="submit" disabled={busy}>
            Save changes
          </Button>
          <Button type="button" variant="secondary" className="text-[#8a1c12]" onClick={() => dialog.current?.showModal()}>
            Delete device
          </Button>
        </div>
      </form>
      <dialog ref={dialog} className="dp-dialog" aria-labelledby="del-title">
        <div className="flex flex-col gap-4 bg-panel p-6">
          <h2 id="del-title" className="m-0 text-lg font-semibold">
            Delete {device.name}?
          </h2>
          <p className="m-0 text-sm text-muted">
            This removes the device and all its readings, findings and diagnoses. Its agent token stops working at once. This cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button type="button" className="!bg-[#b42318] hover:!bg-[#8a1c12]" onClick={remove} disabled={busy}>
              Delete permanently
            </Button>
          </div>
        </div>
      </dialog>
    </Card>
  );
}
