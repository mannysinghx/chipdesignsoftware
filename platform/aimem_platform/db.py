from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, make_url
from sqlalchemy.orm import Session, sessionmaker

from .audit.guard import install_write_guard


class AuditedSession(Session):
    """Session whose commits fail if domain rows changed without an audit event."""


install_write_guard(AuditedSession)


class Database:
    def __init__(self, url: str, *, pool_size: int = 5, max_overflow: int = 5):
        self.url = url
        self.name = make_url(url).database or "unknown"
        self.engine = create_engine(url, pool_pre_ping=True, pool_size=pool_size, max_overflow=max_overflow)
        self._sessions = sessionmaker(bind=self.engine, class_=AuditedSession, expire_on_commit=False)

    def session(self) -> AuditedSession:
        return self._sessions()

    @contextmanager
    def transaction(self) -> Iterator[AuditedSession]:
        session = self.session()
        try:
            yield session
            session.commit()
        except BaseException:
            session.rollback()
            raise
        finally:
            session.close()

    @contextmanager
    def read(self) -> Iterator[AuditedSession]:
        """A session for queries only; it is never committed.

        close() ends the transaction without committing and detaches loaded
        objects with their state intact. rollback() would expire them, so
        reading a field after the block would fail.
        """
        session = self.session()
        try:
            yield session
        finally:
            session.close()

    def dispose(self) -> None:
        self.engine.dispose()
