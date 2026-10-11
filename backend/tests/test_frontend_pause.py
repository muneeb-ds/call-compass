"""The worklet's pause/resume (US-026), checked against the shipped processor.

`frontend/` has no JS test runner, so this drives the *shipped*
`recorder-worklet.js` under node with the AudioWorklet globals stubbed, the same
way `test_frontend_audio.py` drives the resampler - see `pause_fixture.mjs`.

The point is that pausing stops `postMessage` without tearing the processor down:
no chunks while paused, and normal posting resumes afterwards with no special
handling needed on either side of the splice.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parent / "pause_fixture.mjs"

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend worklet"
)


@requires_node
def test_worklet_stops_posting_chunks_while_paused() -> None:
    result = subprocess.run(
        ["node", str(HARNESS)], capture_output=True, check=True, text=True
    )
    data = json.loads(result.stdout)

    assert data["postedWhileRecording"] > 0
    assert data["pausedFlagAfterToggle"] is True
    assert data["postedWhilePaused"] == 0
    assert data["postedAfterResume"] > 0
