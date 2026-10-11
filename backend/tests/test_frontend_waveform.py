"""Pins the shipped `peakEnvelope` downsampling function (`frontend/waveform.js`) under
node — see `waveform_fixture.mjs`.

This is the pure half of US-029's static waveform: the drawing half (`drawRecording`,
`renderRecording`) touches a `CanvasRenderingContext2D` and has no automated coverage
here, same split `viewport.js`'s `frameFor` vs `Viewport` makes elsewhere in this suite.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parent / "waveform_fixture.mjs"

requires_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to run the frontend waveform module"
)


@pytest.fixture(scope="module")
def envelopes() -> dict[str, list[dict[str, float]]]:
    result = subprocess.run(
        ["node", str(HARNESS)], capture_output=True, check=True, text=True
    )
    parsed: dict[str, list[dict[str, float]]] = json.loads(result.stdout)
    return parsed


@requires_node
def test_peak_envelope_splits_a_ramp_into_equal_columns(
    envelopes: dict[str, list[dict[str, float]]],
) -> None:
    assert envelopes["rampFourColumns"] == [
        {"min": -1, "max": -0.75},
        {"min": -0.5, "max": -0.25},
        {"min": 0, "max": 0.25},
        {"min": 0.5, "max": 0.75},
    ]


@requires_node
def test_peak_envelope_one_column_spans_every_sample(
    envelopes: dict[str, list[dict[str, float]]],
) -> None:
    assert envelopes["rampOneColumn"] == [{"min": -1, "max": 0.75}]


@requires_node
def test_peak_envelope_keeps_a_single_sample_spike_visible(
    envelopes: dict[str, list[dict[str, float]]],
) -> None:
    """A min/max pair, not an average, so a one-sample transient is never smoothed away."""
    assert envelopes["spikeFourColumns"] == [
        {"min": 0, "max": 0},
        {"min": 0, "max": 0},
        {"min": 0, "max": 1},
        {"min": 0, "max": 0},
    ]


@requires_node
def test_peak_envelope_handles_fewer_samples_than_columns(
    envelopes: dict[str, list[dict[str, float]]],
) -> None:
    result = envelopes["fewSamplesManyColumns"]
    assert len(result) == 8
    assert all(point["min"] == point["max"] for point in result)
    assert [point["min"] for point in result] == pytest.approx(
        [0.2, 0.2, 0.2, -0.6, -0.6, -0.6, 0.9, 0.9]
    )


@requires_node
def test_peak_envelope_handles_no_samples_at_all(
    envelopes: dict[str, list[dict[str, float]]],
) -> None:
    assert envelopes["empty"] == [{"min": 0, "max": 0}] * 5
