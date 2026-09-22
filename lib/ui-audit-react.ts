'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getUiAudit, installUiAuditListeners, track, type UiAuditSnapshot } from './ui-audit.ts';

/** Install the page-wide interaction listeners once for the lifetime of the page. */
export function useUiAuditInstallation(view: string): void {
  useEffect(() => {
    const client = getUiAudit();
    return client ? installUiAuditListeners(client) : undefined;
  }, []);
  useEffect(() => {
    getUiAudit()?.setContext({ view });
  }, [view]);
}

/** Record `feature.action` with {key, from, to} whenever `value` changes after the first render. */
export function useTrackedValue(feature: string, action: string, key: string, value: unknown): void {
  const previous = useRef<string | null>(null);
  const serialized = JSON.stringify(value ?? null);
  useEffect(() => {
    const before = previous.current;
    previous.current = serialized;
    if (before === null || before === serialized) return;
    track(feature, action, { key, from: JSON.parse(before), to: JSON.parse(serialized) });
  }, [feature, action, key, serialized]);
}

/** Record one ui.param.edited event per changed key of an engineering model configuration. */
export function useTrackedParams(model: string, config: object): void {
  const previous = useRef<Record<string, unknown> | null>(null);
  const serialized = JSON.stringify(config);
  useEffect(() => {
    const current = JSON.parse(serialized) as Record<string, unknown>;
    const before = previous.current;
    previous.current = current;
    if (!before) return;
    for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(current[key])) {
        track('ui.param', 'edited', { model, key, from: before[key] ?? null, to: current[key] ?? null });
      }
    }
  }, [model, serialized]);
}

const noSubscription = () => () => undefined;

/** Live view of this page's audit buffer (null during server rendering). */
export function useUiAuditSnapshot(): UiAuditSnapshot | null {
  const client = typeof window === 'undefined' ? null : getUiAudit();
  return useSyncExternalStore(
    client ? (listener) => client.subscribe(listener) : noSubscription,
    () => (client ? client.cachedSnapshot() : null),
    () => null,
  );
}
