#!/usr/bin/env python
"""Measure CallCompass end-to-end latency over N real runs, for the README's figures.

Boots a real uvicorn with the real NeuDecide model, synthesizes utterances with macOS
`say` + `afconvert` (16 kHz mono 16-bit WAV — exactly what the browser encoder emits),
POSTs each one to `/api/analyze`, and reports median / p95 over the runs.

Two numbers are reported because they answer different questions:

* ``total_latency_ms`` — the server's own end-to-end figure, merged into the terminal
  event by `stream.py`. This is the number the UI's recommendation card shows, so it is
  the one the README quotes.
* ``wall_ms`` — the client's wall clock around the whole HTTP request. It includes
  localhost transport and is therefore always a little larger.

Usage (from the repo root, with HF_TOKEN set or CALLCOMPASS_MODEL_DIR pointed at a
local model directory)::

    .venv/bin/python scripts/bench_latency.py --runs 20
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: The README's demo script, verbatim. Every entry is cycled to fill `--runs`, so the
#: measured spread covers the deepest path (3 inferences) and the level-2 short circuit
#: (1 inference) in the same proportion an operator would actually run them.
UTTERANCES: list[tuple[str, str]] = [
    (
        "rec_budget",
        "What does the Pro tier cost? We're a scaling team but there's no budget this quarter.",
    ),
    (
        "rec_timing",
        "Does it do dashboards for my scaling team? We're interested but mid-project right now.",
    ),
    (
        "rec_competitor",
        "How much is the Pro plan? My team is growing and we're evaluating you against Looker.",
    ),
    (
        "rec_advance",
        "Do you have integrations for my growing team? I'm ready to buy, how do we start a trial?",
    ),
    ("rec_graceful_exit", "I'm really not interested, please don't call here again."),
    ("off_topic", "It's been raining all week and my dog won't go outside."),
]


def synthesize(text: str, out: Path) -> bytes:
    """`say` the text and convert it to 16 kHz mono 16-bit PCM WAV."""
    aiff = out.with_suffix(".aiff")
    subprocess.run(["say", "-o", str(aiff), text], check=True)
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(out)],
        check=True,
    )
    return out.read_bytes()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_health(port: int, timeout: float) -> dict[str, object]:
    """Poll `/api/health` until the model has loaded, or give up."""
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as resp:
                body: dict[str, object] = json.loads(resp.read())
            if body.get("model_loaded"):
                return body
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
            last = str(exc)
        time.sleep(1.0)
    raise SystemExit(f"server never became healthy on port {port}: {last}")


def multipart(wav: bytes, filename: str) -> tuple[bytes, str]:
    """Hand-rolled multipart body, so the script needs no extra dependency."""
    boundary = "----callcompassbench"
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="audio"; filename="{filename}"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + wav + tail, f"multipart/form-data; boundary={boundary}"


def parse_sse(body: str) -> list[tuple[str, dict[str, object]]]:
    frames = []
    for raw in body.split("\n\n"):
        if not raw.strip():
            continue
        event = ""
        data = "{}"
        for line in raw.splitlines():
            if line.startswith("event: "):
                event = line[len("event: ") :]
            elif line.startswith("data: "):
                data = line[len("data: ") :]
        frames.append((event, json.loads(data)))
    return frames


def one_run(port: int, wav: bytes, name: str) -> dict[str, object]:
    body, content_type = multipart(wav, f"{name}.wav")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/analyze",
        data=body,
        headers={"Content-Type": content_type},
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=120) as resp:
        text = resp.read().decode()
    wall_ms = (time.perf_counter() - started) * 1000.0

    frames = parse_sse(text)
    terminal = next(
        ((event, data) for event, data in frames if event in {"completed", "unplaced", "error"}),
        None,
    )
    if terminal is None:
        raise SystemExit(f"run {name} produced no terminal event:\n{text}")
    outcome, payload = terminal
    steps = [data for event, data in frames if event == "step"]
    return {
        "utterance": name,
        "outcome": outcome,
        "inferences": payload.get("inference_count", len(steps)),
        "total_inference_ms": payload.get("total_inference_ms"),
        "total_latency_ms": payload.get("total_latency_ms"),
        "wall_ms": round(wall_ms),
        "leaf": payload.get("label") or payload.get("reason") or payload.get("message"),
    }


def percentile(values: list[float], fraction: float) -> float:
    """Nearest-rank percentile. With 20 samples p95 is the 19th, which is what we want."""
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * len(ordered) + 0.5) - 1))
    return ordered[index]


def summarize(label: str, values: list[float]) -> str:
    return (
        f"{label:<20} median {statistics.median(values):>7.0f} ms   "
        f"p95 {percentile(values, 0.95):>7.0f} ms   "
        f"min {min(values):>7.0f} ms   max {max(values):>7.0f} ms"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--port", type=int, default=0, help="0 picks a free port")
    parser.add_argument("--json", type=Path, help="also write the raw per-run records here")
    args = parser.parse_args()

    port = args.port or free_port()
    tmp = Path(tempfile.mkdtemp(prefix="callcompass-bench-"))
    print(f"synthesizing {len(UTTERANCES)} utterances into {tmp}", flush=True)
    clips = [(name, synthesize(text, tmp / f"{name}.wav")) for name, text in UTTERANCES]

    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    print(f"booting uvicorn on port {port} with the real model", flush=True)
    server = subprocess.Popen(
        [
            str(REPO_ROOT / ".venv" / "bin" / "uvicorn"),
            "callcompass.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=REPO_ROOT / "backend",
        env=env,
    )
    try:
        health = wait_for_health(port, timeout=600)
        print(
            f"model loaded in {health.get('model_load_ms')} ms; "
            f"tree {health.get('tree_id')} ({health.get('node_count')} nodes)",
            flush=True,
        )

        records: list[dict[str, object]] = []
        for index in range(args.runs):
            name, wav = clips[index % len(clips)]
            record = one_run(port, wav, name)
            records.append(record)
            print(
                f"  run {index + 1:>2}/{args.runs}  {name:<15} {record['outcome']:<10} "
                f"{record['inferences']} inf  "
                f"inference {record['total_inference_ms']} ms  "
                f"total {record['total_latency_ms']} ms  wall {record['wall_ms']} ms",
                flush=True,
            )
    finally:
        server.terminate()
        server.wait(timeout=30)

    print()
    print(f"{len(records)} runs on {os.uname().machine} CPU")
    for key in ("total_inference_ms", "total_latency_ms", "wall_ms"):
        print(summarize(key, [float(r[key]) for r in records]))  # type: ignore[arg-type]

    if args.json:
        args.json.write_text(json.dumps(records, indent=2) + "\n")
        print(f"\nraw records written to {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
