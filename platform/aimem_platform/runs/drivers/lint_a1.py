"""Verilator lint of the A1 tensor tile RTL: the T0 lint driver (lint.py, mounted beside this file)
with the A1 targets. Writes <out>/lint.json (deterministic) and <out>/lint.log."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lint  # noqa: E402

# (top module, files) pairs: the full tile plus the dot-product unit on its own.
lint.TARGETS = [
    ("a1_mma_tile", ["a1_dot_terms.sv", "a1_dot_sum.sv", "a1_dot_round.sv", "a1_fp_dot4.sv", "a1_mma_tile.sv"]),
    ("a1_fp_dot4", ["a1_dot_terms.sv", "a1_dot_sum.sv", "a1_dot_round.sv", "a1_fp_dot4.sv"]),
]

if __name__ == "__main__":
    raise SystemExit(lint.main())
