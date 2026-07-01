"""Offline tests for the model-download helper (no network used)."""

from pathlib import Path

import pytest

from gesturewall import sources


def test_partial_download_is_cleaned_up(tmp_path, monkeypatch):
    target = tmp_path / "models" / "pose.task"

    def fake_urlretrieve(url, filename):
        Path(filename).write_bytes(b"partial-bytes")   # simulate a partial write
        raise RuntimeError("network dropped mid-download")

    monkeypatch.setattr(sources.urllib.request, "urlretrieve", fake_urlretrieve)

    with pytest.raises(RuntimeError):
        sources.ensure_pose_model(str(target), url="http://example/model")

    # Neither the final file nor the .part temp may survive a failed download.
    assert not target.exists()
    assert not target.with_suffix(target.suffix + ".part").exists()


def test_successful_download_is_atomic_and_cached(tmp_path, monkeypatch):
    target = tmp_path / "models" / "pose.task"

    def good_urlretrieve(url, filename):
        Path(filename).write_bytes(b"GOOD-MODEL")

    monkeypatch.setattr(sources.urllib.request, "urlretrieve", good_urlretrieve)
    path = sources.ensure_pose_model(str(target), url="http://example/model")
    assert Path(path).read_bytes() == b"GOOD-MODEL"
    assert not target.with_suffix(target.suffix + ".part").exists()

    # A second call must NOT re-download (file already present).
    def boom(url, filename):
        raise AssertionError("should not download when the model exists")

    monkeypatch.setattr(sources.urllib.request, "urlretrieve", boom)
    sources.ensure_pose_model(str(target), url="http://example/model")
