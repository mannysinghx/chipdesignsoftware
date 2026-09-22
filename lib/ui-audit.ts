// Browser audit client: every UI action is recorded locally first, then shipped
// in batches to the platform API (POST /api/events/ui), where each event becomes
// a row in the hash-chained audit log.
//
// Nothing is dropped silently. Without a configured API (for example the
// public static deployment) events stay in this page's buffer, visible in the
// Activity workspace and labeled local-only. Network failures keep events
// queued with exponential backoff; server rejections are kept with a reason.

export type UiAuditResult = 'ok' | 'error' | 'info';
export type UiAuditStatus = 'queued' | 'sent' | 'rejected' | 'local';
export type UiAuditMode = 'local-only' | 'connected' | 'offline' | 'unauthorized';

export type UiAuditTarget = { type: string; id: string };

export type UiAuditEvent = {
  event_id: string;
  feature: string;
  action: string;
  client_ts: string;
  trace_id: string;
  parent_event_id: string | null;
  target?: UiAuditTarget;
  details: Record<string, unknown>;
  result: UiAuditResult;
  error?: string;
  status: UiAuditStatus;
  reason?: string;
};

export type RecordOptions = {
  target?: UiAuditTarget;
  result?: UiAuditResult;
  error?: string;
  parent?: string | null;
  traceId?: string;
};

export type UiAuditSnapshot = {
  mode: UiAuditMode;
  apiBase: string | null;
  sessionId: string;
  counts: { recorded: number; sent: number; queued: number; rejected: number; dropped: number };
  lastError: string | null;
  events: UiAuditEvent[];
};

type FetchLike = (input: string, init: { method: string; body: string; headers: Record<string, string>; credentials: 'include'; keepalive?: boolean }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>;

export type UiAuditOptions = {
  apiBase: string | null;
  sessionId?: string;
  appBuild?: string;
  fetchImpl?: FetchLike;
  beacon?: (url: string, body: string) => boolean;
  now?: () => number;
  flushIntervalMs?: number;
  maxBuffer?: number;
  maxQueue?: number;
  maxBatch?: number;
  interactionLinkMs?: number;
  schedule?: (callback: () => void, ms: number) => unknown;
};

const HEX = '0123456789abcdef';

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function newTraceId(): string {
  let out = '';
  for (const byte of randomBytes(16)) out += HEX[byte >> 4] + HEX[byte & 15];
  return out === '0'.repeat(32) ? newTraceId() : out;
}

/** RFC 4122 v4 UUID. crypto.randomUUID only exists in secure contexts, so build it from random bytes. */
export function newUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let hex = '';
  for (const byte of bytes) hex += HEX[byte >> 4] + HEX[byte & 15];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Where UI events go. An explicit setting wins ('off' disables shipping). Pages
 * served from localhost default to the local platform API on port 8100. Anything
 * else (such as the public deployment) stays local-only, so a deployed page never
 * calls a visitor's localhost.
 */
export function resolveApiBase(location: { protocol: string; hostname: string }, configured?: string | null, override?: string | null): string | null {
  const chosen = (override ?? configured ?? '').trim();
  if (chosen === 'off') return null;
  if (chosen) return chosen.replace(/\/+$/, '');
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return `${location.protocol}//${location.hostname}:8100`;
  return null;
}

const REDACTED_INPUT_TYPES = new Set(['password', 'email', 'tel']);

/** Values safe to log for a changed control. Passwords are never read; emails and phone numbers are withheld. */
export function auditValue(input: { type?: string; value?: unknown; checked?: boolean; redact?: boolean }): { value?: unknown; redacted?: true } {
  const type = (input.type ?? '').toLowerCase();
  if (input.redact || REDACTED_INPUT_TYPES.has(type)) return { redacted: true };
  if (type === 'checkbox' || type === 'radio') return { value: Boolean(input.checked) };
  if (typeof input.value === 'string') {
    const numeric = type === 'range' || type === 'number' ? Number(input.value) : Number.NaN;
    return { value: Number.isFinite(numeric) ? numeric : input.value.slice(0, 200) };
  }
  return { value: input.value };
}

export function normalizeLabel(text: string | null | undefined, limit = 120): string {
  const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

export class UiAuditClient {
  readonly sessionId: string;
  readonly apiBase: string | null;
  readonly appBuild: string | undefined;
  mode: UiAuditMode;
  lastError: string | null = null;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly beacon: ((url: string, body: string) => boolean) | undefined;
  private readonly now: () => number;
  private readonly flushIntervalMs: number;
  private readonly maxBuffer: number;
  private readonly maxQueue: number;
  private readonly maxBatch: number;
  private readonly interactionLinkMs: number;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private buffer: UiAuditEvent[] = [];
  private queue: UiAuditEvent[] = [];
  private context: Record<string, unknown> = {};
  private lastInteraction: { id: string; traceId: string; at: number } | null = null;
  private listeners = new Set<() => void>();
  private flushing = false;
  private timerArmed = false;
  private backoffMs = 0;
  private blockedUntil = 0;
  private counts = { recorded: 0, sent: 0, rejected: 0, dropped: 0 };
  private version = 0;
  private cached: { version: number; snapshot: UiAuditSnapshot } | null = null;

  constructor(options: UiAuditOptions) {
    this.apiBase = options.apiBase;
    this.sessionId = options.sessionId ?? newUuid();
    this.appBuild = options.appBuild;
    this.fetchImpl = options.fetchImpl;
    this.beacon = options.beacon;
    this.now = options.now ?? (() => Date.now());
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.maxBuffer = options.maxBuffer ?? 1000;
    this.maxQueue = options.maxQueue ?? 5000;
    this.maxBatch = options.maxBatch ?? 50;
    this.interactionLinkMs = options.interactionLinkMs ?? 1500;
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.mode = this.apiBase ? 'connected' : 'local-only';
  }

  setContext(patch: Record<string, unknown>): void {
    this.context = { ...this.context, ...patch };
  }

  /** Record a UI interaction and make it the parent of events it causes in the next moment. */
  interaction(action: string, details: Record<string, unknown>, target?: UiAuditTarget): UiAuditEvent {
    const event = this.record('ui.interaction', action, details, { target, parent: null, traceId: newTraceId() });
    this.lastInteraction = { id: event.event_id, traceId: event.trace_id, at: this.now() };
    return event;
  }

  record(feature: string, action: string, details: Record<string, unknown> = {}, options: RecordOptions = {}): UiAuditEvent {
    const recent = this.lastInteraction && this.now() - this.lastInteraction.at <= this.interactionLinkMs ? this.lastInteraction : null;
    const parent = options.parent !== undefined ? options.parent : recent?.id ?? null;
    const traceId = options.traceId ?? (options.parent === undefined && recent ? recent.traceId : newTraceId());
    const event: UiAuditEvent = {
      event_id: newUuid(),
      feature,
      action,
      client_ts: new Date(this.now()).toISOString(),
      trace_id: traceId,
      parent_event_id: parent,
      details: { ...this.context, ...details },
      result: options.result ?? 'ok',
      status: this.apiBase ? 'queued' : 'local',
    };
    if (options.target) event.target = options.target;
    if (options.error) event.error = options.error.slice(0, 20_000);
    this.counts.recorded += 1;
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    if (this.apiBase) {
      this.queue.push(event);
      if (this.queue.length > this.maxQueue) {
        const dropped = this.queue.splice(0, this.queue.length - this.maxQueue);
        this.counts.dropped += dropped.length;
        this.lastError = `${this.counts.dropped} queued events were dropped because the platform API was unreachable for too long`;
      }
      if (this.queue.length >= this.maxBatch) void this.flush();
      else this.arm();
    }
    this.emit();
    return event;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The same object until something changes, as useSyncExternalStore requires. */
  cachedSnapshot(): UiAuditSnapshot {
    if (!this.cached || this.cached.version !== this.version) this.cached = { version: this.version, snapshot: this.snapshot() };
    return this.cached.snapshot;
  }

  snapshot(): UiAuditSnapshot {
    return {
      mode: this.mode,
      apiBase: this.apiBase,
      sessionId: this.sessionId,
      counts: { ...this.counts, queued: this.queue.length },
      lastError: this.lastError,
      events: [...this.buffer].reverse(),
    };
  }

  /** Retry immediately, for example right after signing in. */
  retryNow(): Promise<void> {
    this.backoffMs = 0;
    this.blockedUntil = 0;
    return this.flush();
  }

  async flush(): Promise<void> {
    if (!this.apiBase || !this.fetchImpl || this.flushing || this.queue.length === 0) return;
    if (this.now() < this.blockedUntil) {
      this.arm(this.blockedUntil - this.now());
      return;
    }
    this.flushing = true;
    const batch = this.queue.slice(0, this.maxBatch);
    try {
      const response = await this.fetchImpl(`${this.apiBase}/api/events/ui`, {
        method: 'POST',
        body: this.payload(batch),
        // text/plain keeps this a CORS simple request: no preflight per flush.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        credentials: 'include',
        keepalive: true,
      });
      if (response.ok) {
        const body = (await response.json()) as { rejections?: Array<{ event_id?: string; reason: string }> };
        const rejected = new Map((body.rejections ?? []).filter((item) => item.event_id).map((item) => [item.event_id as string, item.reason]));
        for (const event of batch) {
          const reason = rejected.get(event.event_id);
          event.status = reason ? 'rejected' : 'sent';
          if (reason) event.reason = reason;
          this.counts[reason ? 'rejected' : 'sent'] += 1;
        }
        this.queue.splice(0, batch.length);
        this.mode = 'connected';
        this.lastError = null;
        this.backoffMs = 0;
      } else if (response.status === 401) {
        this.mode = 'unauthorized';
        this.lastError = 'The platform API requires sign-in to record browser events. Events stay queued in this page.';
        this.backoff();
      } else {
        this.mode = 'offline';
        this.lastError = `The platform API answered ${response.status}; events stay queued and will be retried.`;
        this.backoff();
      }
    } catch (error) {
      this.mode = 'offline';
      this.lastError = `The platform API is unreachable (${error instanceof Error ? error.message : String(error)}); events stay queued.`;
      this.backoff();
    } finally {
      this.flushing = false;
      this.emit();
    }
    if (this.queue.length && this.mode === 'connected') this.arm(0);
  }

  /** Last-chance delivery while the page unloads. A beacon cannot report the server's answer, so accepted beacons mark their events sent. */
  flushWithBeacon(): void {
    if (!this.apiBase || !this.beacon || this.queue.length === 0) return;
    while (this.queue.length) {
      const batch = this.queue.slice(0, this.maxBatch);
      if (!this.beacon(`${this.apiBase}/api/events/ui`, this.payload(batch))) break;
      for (const event of batch) event.status = 'sent';
      this.counts.sent += batch.length;
      this.queue.splice(0, batch.length);
    }
  }

  private payload(batch: UiAuditEvent[]): string {
    return JSON.stringify({
      session_id: this.sessionId,
      app_build: this.appBuild,
      events: batch.map((event) => ({
        event_id: event.event_id,
        feature: event.feature,
        action: event.action,
        client_ts: event.client_ts,
        trace_id: event.trace_id,
        parent_event_id: event.parent_event_id,
        target: event.target,
        details: event.details,
        result: event.result,
        error: event.error,
      })),
    });
  }

  private backoff(): void {
    this.backoffMs = Math.min(60_000, this.backoffMs ? this.backoffMs * 2 : 2000);
    this.blockedUntil = this.now() + this.backoffMs;
    this.arm(this.backoffMs);
  }

  private arm(ms = this.flushIntervalMs): void {
    if (this.timerArmed) return;
    this.timerArmed = true;
    this.schedule(() => {
      this.timerArmed = false;
      void this.flush();
    }, ms);
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------

type AuditWindow = Window & { __aimemAudit?: UiAuditClient };

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  'canvas',
  '[role="button"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[data-audit]',
].join(',');

function configuredApi(): string | null {
  try {
    return typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_AIMEM_PLATFORM_API ?? null : null;
  } catch {
    return null;
  }
}

function storedOverride(): string | null {
  try {
    return window.localStorage.getItem('aimem.platformApi');
  } catch {
    return null;
  }
}

/** The page-wide client, created on first use in the browser. Returns null during server rendering. */
export function getUiAudit(): UiAuditClient | null {
  if (typeof window === 'undefined') return null;
  const scope = window as AuditWindow;
  if (!scope.__aimemAudit) {
    const apiBase = resolveApiBase(window.location, configuredApi(), storedOverride());
    scope.__aimemAudit = new UiAuditClient({
      apiBase,
      appBuild: '0.1.0',
      fetchImpl: typeof fetch === 'function' ? (url, init) => fetch(url, init) : undefined,
      beacon:
        typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
          ? (url, body) => navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))
          : undefined,
    });
  }
  return scope.__aimemAudit;
}

/** Convenience wrapper: record a semantic event if the client exists. */
export function track(feature: string, action: string, details: Record<string, unknown> = {}, options: RecordOptions = {}): UiAuditEvent | null {
  return getUiAudit()?.record(feature, action, details, options) ?? null;
}

/** Record an export with the byte count and SHA-256 of exactly what was downloaded. */
export function trackExport(file: string, text: string, details: Record<string, unknown> = {}): void {
  const bytes = new TextEncoder().encode(text);
  const base = { file, bytes: bytes.length, ...details };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    track('ui.export', 'exported', { ...base, sha256: null, note: 'SubtleCrypto unavailable outside secure contexts' });
    return;
  }
  subtle.digest('SHA-256', bytes).then(
    (digest) => {
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      track('ui.export', 'exported', { ...base, sha256 });
    },
    () => track('ui.export', 'exported', { ...base, sha256: null }),
  );
}

export type ControlDescriptor = {
  tag: string;
  role?: string;
  type?: string;
  label: string;
  id?: string;
  name?: string;
  pressed?: string;
  area?: string;
};

export function describeControl(element: Element): ControlDescriptor {
  const html = element as HTMLElement & { type?: string; name?: string; labels?: NodeListOf<HTMLLabelElement> | null };
  const labelled = element.getAttribute('aria-label') || element.getAttribute('data-audit-label');
  const fromLabel = html.labels && html.labels.length ? html.labels[0].textContent : null;
  const fallback = element.tagName === 'CANVAS' ? (element.parentElement?.getAttribute('aria-label') ?? 'canvas') : null;
  const label = normalizeLabel(labelled || fromLabel || html.textContent || element.getAttribute('title') || html.name || element.id || fallback);
  const area = element.closest('[data-audit-area]')?.getAttribute('data-audit-area') ?? element.closest('[aria-label]')?.getAttribute('aria-label') ?? undefined;
  const descriptor: ControlDescriptor = { tag: element.tagName.toLowerCase(), label: label || element.tagName.toLowerCase() };
  const role = element.getAttribute('role');
  if (role) descriptor.role = role;
  if (html.type && typeof html.type === 'string') descriptor.type = html.type;
  if (element.id) descriptor.id = element.id;
  if (html.name) descriptor.name = html.name;
  const pressed = element.getAttribute('aria-pressed');
  if (pressed) descriptor.pressed = pressed;
  if (area && area !== descriptor.label) descriptor.area = normalizeLabel(area, 80);
  return descriptor;
}

function shouldRedact(element: Element): boolean {
  return Boolean(element.closest('[data-audit-redact]'));
}

/**
 * Install document-level capture listeners that record every interaction:
 * clicks on any control, committed changes to inputs and selects, form submits,
 * keyboard shortcuts, page errors, and page load/unload. Capture phase runs
 * before React handlers and before any stopPropagation, so nothing is missed,
 * and events the handlers record link back to the interaction as their parent.
 */
export function installUiAuditListeners(client: UiAuditClient): () => void {
  const scope = window as AuditWindow & { __aimemAuditInstalled?: boolean; __aimemSessionStarted?: boolean };
  if (scope.__aimemAuditInstalled) return () => undefined;
  scope.__aimemAuditInstalled = true;
  let pointerDown: { x: number; y: number } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    pointerDown = { x: event.clientX, y: event.clientY };
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest(INTERACTIVE_SELECTOR);
    if (!control) return;
    if (control.tagName === 'CANVAS' && pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return; // a drag: logged as a camera gesture
    const descriptor = describeControl(control);
    client.interaction('click', { control: descriptor }, { type: 'control', id: descriptor.label });
  };
  const onChange = (event: Event) => {
    // Kept as Element: @cloudflare/workers-types also declares a global Element, and
    // the merged type rejects HTMLSelectElement, so input properties are read via a cast.
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const input = element as unknown as HTMLInputElement;
    const descriptor = describeControl(element);
    const value = auditValue({ type: input.type, value: input.value, checked: input.checked, redact: shouldRedact(element) });
    client.interaction('change', { control: descriptor, ...value }, { type: 'control', id: descriptor.label });
  };
  const onSubmit = (event: Event) => {
    const form = event.target instanceof Element ? event.target : null;
    if (!form) return;
    const descriptor = describeControl(form);
    client.interaction('submit', { control: descriptor }, { type: 'form', id: descriptor.label });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
    const combo = event.ctrlKey || event.metaKey || event.altKey;
    if (event.key !== 'Escape' && !(combo && !editable)) return;
    const keys = [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift', event.key].filter(Boolean).join('+');
    client.interaction('key', { key: keys, control: event.target instanceof Element ? describeControl(event.target) : undefined }, { type: 'key', id: keys });
  };
  const onError = (event: ErrorEvent) => {
    client.record('ui.error', 'error', { message: normalizeLabel(event.message, 500), source: event.filename, line: event.lineno, column: event.colno }, {
      result: 'error',
      error: event.error instanceof Error ? event.error.stack ?? String(event.error) : String(event.message),
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    client.record('ui.error', 'unhandled_rejection', { message: normalizeLabel(reason instanceof Error ? reason.message : String(reason), 500) }, {
      result: 'error',
      error: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
    });
  };
  const onPageHide = () => {
    client.record('ui.session', 'ended', { path: window.location.pathname });
    client.flushWithBeacon();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void client.flush();
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', onPageHide);

  if (!scope.__aimemSessionStarted) {
    scope.__aimemSessionStarted = true;
    client.record('ui.session', 'started', {
      path: window.location.pathname,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      language: navigator.language,
      user_agent: navigator.userAgent.slice(0, 300),
      api: client.apiBase ?? 'local-only',
    });
  }

  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('submit', onSubmit, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('pagehide', onPageHide);
    scope.__aimemAuditInstalled = false;
  };
}
