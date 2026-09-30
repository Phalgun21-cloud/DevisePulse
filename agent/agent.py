"""DevicePulse agent.

Collects battery and system readings and uploads them to the DevicePulse API.
Numbers only: it never reads files, browsing data or screen content.

    python agent/agent.py --server http://localhost:4000 --token <DEVICE_TOKEN>

Design: collect() talks to the OS; build_payload() and the buffer helpers are pure
or file-only, so they are unit-tested without touching real hardware.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MAX_BATCH = 100
DEFAULT_BUFFER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "buffer.jsonl")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_payload(
    battery: Optional[dict],
    system: Optional[dict],
    ts: Optional[str] = None,
    storage: Optional[dict] = None,
) -> list[dict]:
    """Pure. Turn readings into the sample list the API expects.

    A missing reading (None) produces no sample at all, never a sample of zeros.
    """
    stamp = ts or now_iso()
    samples: list[dict] = []
    if battery:
        samples.append({"ts": stamp, "kind": "battery", "values": battery})
    if system:
        samples.append({"ts": stamp, "kind": "cpu", "values": system})
    if storage:
        samples.append({"ts": stamp, "kind": "storage", "values": storage})
    return samples


def collect_storage() -> Optional[dict]:
    """Timed disk probe + free space + SMART (if smartctl is available). Never raises."""
    try:
        from collectors.storage import read_storage

        return read_storage()
    except Exception as exc:  # noqa: BLE001
        print(f"[agent] storage read failed: {exc}", file=sys.stderr)
        return None


def collect(include_battery: bool) -> tuple[Optional[dict], Optional[dict]]:
    """Talk to the OS. Never raises: a failed sensor just yields None."""
    battery = None
    system = None
    if include_battery:
        try:
            from collectors.battery import read_battery

            battery = read_battery()
        except Exception as exc:  # noqa: BLE001
            print(f"[agent] battery read failed: {exc}", file=sys.stderr)
    try:
        from collectors.system import read_system

        system = read_system()
    except Exception as exc:  # noqa: BLE001
        print(f"[agent] system read failed: {exc}", file=sys.stderr)
    return battery, system


# ----- offline buffer (JSON lines) -------------------------------------------------


def buffer_append(path: str, samples: list[dict]) -> None:
    if not samples:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for sample in samples:
            fh.write(json.dumps(sample) + "\n")


def buffer_read(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    out: list[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # skip a torn line from a crash mid-write
    return out


def buffer_clear(path: str) -> None:
    if os.path.exists(path):
        os.remove(path)


def buffer_replace(path: str, samples: list[dict]) -> None:
    buffer_clear(path)
    buffer_append(path, samples)


# ----- upload ----------------------------------------------------------------------


def upload(server: str, token: str, samples: list[dict], session=None) -> bool:
    """POST one batch. Returns True only if the server accepted it."""
    if not samples:
        return True
    if session is None:
        import requests

        session = requests
    try:
        resp = session.post(
            server.rstrip("/") + "/api/ingest",
            json={"samples": samples[:MAX_BATCH]},
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
    except Exception as exc:  # noqa: BLE001 - offline, DNS, timeout...
        print(f"[agent] upload failed: {exc}", file=sys.stderr)
        return False
    if resp.status_code == 401:
        print("[agent] server rejected the device token (401). Check --token.", file=sys.stderr)
        return False
    return 200 <= resp.status_code < 300


def flush(server: str, token: str, buffer_path: str, session=None) -> int:
    """Send buffered samples in order. Keeps whatever was not accepted. Returns sent count."""
    pending = buffer_read(buffer_path)
    sent = 0
    while pending:
        batch = pending[:MAX_BATCH]
        if not upload(server, token, batch, session=session):
            break
        sent += len(batch)
        pending = pending[MAX_BATCH:]
    if pending:
        buffer_replace(buffer_path, pending)
    else:
        buffer_clear(buffer_path)
    return sent


def run_once(
    server: str, token: str, buffer_path: str, include_battery: bool, session=None, include_storage: bool = False
) -> int:
    battery, system = collect(include_battery)
    storage = collect_storage() if include_storage else None
    samples = build_payload(battery, system, storage=storage)
    buffer_append(buffer_path, samples)
    return flush(server, token, buffer_path, session=session)


# ----- command channel (slow-laptop diagnosis) -------------------------------------------

POLL_SECONDS = 15
MAX_DIAGNOSE_SECONDS = 30  # whatever the server asks for, never sample longer than this


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def poll_commands(server: str, token: str, session=None) -> list[dict]:
    """GET pending commands. Quiet on any failure: the next poll simply tries again."""
    if session is None:
        import requests

        session = requests
    try:
        resp = session.get(server.rstrip("/") + "/api/agent/commands", headers=_auth(token), timeout=10)
        if resp.status_code != 200:
            return []
        commands = resp.json().get("commands")
    except Exception:  # noqa: BLE001 - offline, bad JSON...
        return []
    return commands if isinstance(commands, list) else []


def handle_command(command: dict, server: str, token: str, session=None, sampler=None) -> bool:
    """Run one command and post the result. Only 'diagnose' is understood; all else is ignored."""
    if command.get("type") != "diagnose":
        return False
    if sampler is None:
        from collectors.diagnose import take_sample as sampler
    if session is None:
        import requests

        session = requests
    seconds = min(float(command.get("durationSec") or 10), MAX_DIAGNOSE_SECONDS)
    try:
        sample = sampler(seconds)
        resp = session.post(
            f"{server.rstrip('/')}/api/agent/commands/{command['id']}/result",
            json={"sample": sample},
            headers=_auth(token),
            timeout=15,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[agent] diagnose failed: {exc}", file=sys.stderr)
        return False
    return 200 <= resp.status_code < 300


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="DevicePulse agent")
    parser.add_argument("--server", default=os.environ.get("DEVICEPULSE_SERVER", "http://localhost:4000"))
    parser.add_argument("--token", default=os.environ.get("DEVICEPULSE_TOKEN"))
    parser.add_argument("--interval", type=int, default=60, help="seconds between system samples")
    parser.add_argument(
        "--battery-every", type=int, default=3600, help="seconds between battery capacity reads"
    )
    parser.add_argument(
        "--storage-every", type=int, default=900, help="seconds between timed disk probes (8 MB write+read)"
    )
    parser.add_argument("--buffer", default=DEFAULT_BUFFER)
    parser.add_argument("--once", action="store_true", help="collect and upload once, then exit")
    args = parser.parse_args(argv)

    if not args.token:
        print("Missing --token (or DEVICEPULSE_TOKEN). Create a device in the web app first.", file=sys.stderr)
        return 2

    print(f"[agent] uploading to {args.server} every {args.interval}s. Ctrl+C to stop.")
    last_battery = 0.0
    last_storage = float("-inf")
    last_upload = float("-inf")
    try:
        while True:
            tick = time.monotonic()
            if tick - last_upload >= args.interval:
                due = (tick - last_battery) >= args.battery_every or last_battery == 0.0
                storage_due = (tick - last_storage) >= args.storage_every
                sent = run_once(
                    args.server, args.token, args.buffer, include_battery=due, include_storage=storage_due
                )
                last_upload = time.monotonic()
                if due:
                    last_battery = last_upload
                if storage_due:
                    last_storage = last_upload
                print(f"[agent] {now_iso()} sent {sent} sample(s); buffered {len(buffer_read(args.buffer))}")
            if args.once:
                return 0
            # Command channel: check for a "diagnose" request every POLL_SECONDS.
            for command in poll_commands(args.server, args.token):
                ok = handle_command(command, args.server, args.token)
                print(f"[agent] {now_iso()} command {command.get('type')} #{command.get('id')}: {'done' if ok else 'failed'}")
            time.sleep(max(1.0, min(POLL_SECONDS, args.interval)))
    except KeyboardInterrupt:
        print("[agent] stopped.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
