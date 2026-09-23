"""Phase 1: sandboxed, reproducible, fully audited tool runs.

A run is identified by the hash of everything that determines its outputs: the
pinned image and toolchain digests, the command, the environment, and the
content hash of every input file. Its whole history is written to the audit log
(run.lifecycle), complete enough to rebuild the run from the log alone.
"""
