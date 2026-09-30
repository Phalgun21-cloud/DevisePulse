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
    return samples


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


def run_once(server: str, token: str, buffer_path: str, include_battery: bool, session=None) -> int:
    battery, system = collect(include_battery)
    samples = build_payload(battery, system)
    buffer_append(buffer_path, samples)
    return flush(server, token, buffer_path, session=session)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="DevicePulse agent")
    parser.add_argument("--server", default=os.environ.get("DEVICEPULSE_SERVER", "http://localhost:4000"))
    parser.add_argument("--token", default=os.environ.get("DEVICEPULSE_TOKEN"))
    parser.add_argument("--interval", type=int, default=60, help="seconds between system samples")
    parser.add_argument(
        "--battery-every", type=int, default=3600, help="seconds between battery capacity reads"
    )
    parser.add_argument("--buffer", default=DEFAULT_BUFFER)
    parser.add_argument("--once", action="store_true", help="collect and upload once, then exit")
    args = parser.parse_args(argv)

    if not args.token:
        print("Missing --token (or DEVICEPULSE_TOKEN). Create a device in the web app first.", file=sys.stderr)
        return 2

    print(f"[agent] uploading to {args.server} every {args.interval}s. Ctrl+C to stop.")
    last_battery = 0.0
    while True:
        due = (time.monotonic() - last_battery) >= args.battery_every or last_battery == 0.0
        sent = run_once(args.server, args.token, args.buffer, include_battery=due)
        if due:
            last_battery = time.monotonic()
        print(f"[agent] {now_iso()} sent {sent} sample(s); buffered {len(buffer_read(args.buffer))}")
        if args.once:
            return 0
        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            print("[agent] stopped.")
            return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
