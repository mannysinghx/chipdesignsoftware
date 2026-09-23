'use client';

import { useEffect, useState } from 'react';
import { useUiAuditSnapshot } from '@/lib/ui-audit-react';
import { platformFetch, type EvidenceItem } from '@/lib/platform-api';

/**
 * Latest platform-executed evidence for the given adapters, shown above a workspace's
 * static evidence. Renders nothing without a platform API or signed-in session, so the
 * static (versioned JSON) evidence remains the fallback.
 */
export default function LiveEvidenceStrip({ adapters, onOpenRuns }: { adapters: string[]; onOpenRuns: () => void }) {
  const snapshot = useUiAuditSnapshot();
  const apiBase = snapshot?.apiBase ?? null;
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const key = adapters.join(',');

  useEffect(() => {
    if (!apiBase) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await platformFetch<{ evidence: EvidenceItem[] }>('/api/evidence');
      if (!cancelled && result.status === 200 && result.body) {
        setItems(result.body.evidence.filter((item) => key.split(',').includes(item.adapter.id)));
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiBase, key]);

  if (!items || items.every((item) => !item.latest)) return null;
  return (
    <div className="live-evidence" data-audit-area="Live evidence">
      <span className="live-evidence-label">Executed by the platform</span>
      {items.map((item) => {
        const run = item.latest;
        if (!run) return null;
        const verdict = run.verdict ?? run.status;
        return (
          <button key={item.adapter.id} className={`live-evidence-item ${verdict}`} onClick={onOpenRuns} title={run.summary?.headline ?? ''}>
            <b>{item.adapter.title.split(' (')[0]}</b>
            <span>{verdict}</span>
            <small>{run.summary?.headline ?? ''}</small>
          </button>
        );
      })}
    </div>
  );
}
