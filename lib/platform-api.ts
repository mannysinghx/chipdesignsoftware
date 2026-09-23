// Minimal client for the platform API, shared by the Runs workspace and the live-evidence strips.
// The API base comes from the audit client, which already resolves it (explicit setting,
// localhost default, or none on a public deployment).

import { getUiAudit } from './ui-audit.ts';

export type ApiResult<T> = { status: number; body: T | null };

export function platformBase(): string | null {
  return getUiAudit()?.apiBase ?? null;
}

export async function platformFetch<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const base = platformBase();
  if (!base) return { status: 0, body: null };
  const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export function artifactUrl(sha256: string): string | null {
  const base = platformBase();
  return base ? `${base}/api/artifacts/${sha256}` : null;
}

export type RunSummary = {
  verdict: 'pass' | 'fail' | 'error' | null;
  headline: string;
  metrics?: Record<string, unknown>;
  execution?: { status: string; exit_code: number | null; wall_ms: number; runner: string };
  isolation?: Record<string, unknown>;
};

export type RunFileEntry = { role: 'input' | 'output' | 'log'; path: string; sha256: string; size_bytes: number; normalized_sha256: string | null };

export type PlatformRun = {
  run_id: string;
  adapter: string;
  title: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'errored' | 'timed_out' | 'cancelled';
  verdict: string | null;
  spec_hash: string;
  params: Record<string, unknown>;
  requested_by: string;
  trace_id: string;
  git: { revision: string | null; inputs_differ_from_revision: boolean | null } | null;
  reproduction_of: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  runner: string | null;
  exit_code: number | null;
  summary: RunSummary | null;
  output_manifest_hash: string | null;
  evidence_class: string | null;
  error: string | null;
  cancel_requested: boolean;
  spec?: { execution: Record<string, unknown>; limits: Record<string, number>; spec_hash: string };
  files?: RunFileEntry[];
};

export type AdapterInfo = { id: string; title: string; description: string; evidence: string; image: string; bundles: string[]; limits: Record<string, number> };

export type EvidenceItem = {
  adapter: AdapterInfo;
  latest: PlatformRun | null;
  active: PlatformRun | null;
  reproduced: { runs: number; identical: boolean } | null;
};
