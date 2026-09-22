from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowLimiter:
    """In-process sliding-window limiter. Single-process only; Phase 5 moves this to a shared store."""

    def __init__(self, limit: int, window_seconds: float = 60.0, clock=time.monotonic):
        self.limit = limit
        self.window = window_seconds
        self.clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, cost: int = 1) -> bool:
        now = self.clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] > self.window:
                hits.popleft()
            if len(hits) + cost > self.limit:
                return False
            hits.extend([now] * cost)
            if len(self._hits) > 10_000:
                self._evict(now)
            return True

    def _evict(self, now: float) -> None:
        for key in [key for key, hits in self._hits.items() if not hits or now - hits[-1] > self.window]:
            del self._hits[key]
