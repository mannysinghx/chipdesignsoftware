"""The A1 adapters (compute-die step C2) are additive: T0 run inputs, and so T0 spec hashes, are unchanged."""

from __future__ import annotations

from pathlib import Path

from aimem_platform.runs.adapters import ADAPTERS

REPO = Path(__file__).resolve().parents[2]
T0 = ("rtl.lint", "rtl.sim", "formal.sby")
A1 = ("a1.lint", "a1.sim", "a1.formal")


def test_a1_adapters_are_registered():
    assert set(A1) <= set(ADAPTERS)


def test_t0_adapters_read_no_a1_files():
    for adapter_id in T0:
        adapter = ADAPTERS[adapter_id]
        paths = adapter.inputs(adapter.params_model(), REPO)
        assert not any("a1" in Path(name).parts or Path(name).name.startswith("a1_") for name in paths), (adapter_id, sorted(paths))
        assert not any("a1" in source.relative_to(REPO).parts for source in paths.values()), adapter_id


def test_a1_adapters_read_only_a1_files_and_their_drivers():
    for adapter_id in A1:
        adapter = ADAPTERS[adapter_id]
        paths = adapter.inputs(adapter.params_model(), REPO)
        for name, source in paths.items():
            assert source.is_file(), (adapter_id, name)
            relative = source.relative_to(REPO)
            assert "a1" in relative.parts or relative.parts[:4] == ("platform", "aimem_platform", "runs", "drivers"), (adapter_id, relative)
        # every file a command names is one of its inputs
        for argument in adapter.command(adapter.params_model()):
            if argument.startswith("/work/in/") and Path(argument).suffix:
                assert argument.removeprefix("/work/in/") in paths, (adapter_id, argument)


def test_a1_inputs_keep_repository_paths():
    """The same scripts run in and out of the sandbox, so sandbox paths mirror the repository."""
    sim = ADAPTERS["a1.sim"].inputs(ADAPTERS["a1.sim"].params_model(), REPO)
    assert "rtl/a1/a1_mma_tile.sv" in sim and "verification/a1/golden.py" in sim
    formal = ADAPTERS["a1.formal"].inputs(ADAPTERS["a1.formal"].params_model(), REPO)
    assert {"formal/a1/a1_tile.sby", "formal/a1/a1_dot4.sby", "formal/a1/run_formal.py", "rtl/a1/a1_fp_dot4.sv"} <= set(formal)
