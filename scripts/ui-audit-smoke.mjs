#!/usr/bin/env node
// UI audit smoke test (Phase 0 exit criterion).
//
// Proves, against the real Studio in a real browser, that:
//   1. every interactive control in every view emits an audit event,
//   2. every event recorded by the page is delivered to the platform audit log,
//   3. every ui.* action declared in platform/features.yaml is emitted by the UI,
//   4. the audit hash chain still verifies afterwards.
//
// Usage (the Studio app must already be running):
//   node scripts/ui-audit-smoke.mjs [--app http://localhost:3000] [--api-port 8101] [--out outputs/ui-audit-smoke]
//
// The script starts its own platform API against the TEST database
// (AIMEM_TEST_DATABASE_URL from the environment or platform/.env; the name must
// end in _test), creates a throwaway admin with a random password, signs the
// browser in by cookie, and stops only the API process it started.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM = path.join(ROOT, 'platform');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, index, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1]]] : pairs), []));
const APP = args.app ?? 'http://localhost:3000';
const API_PORT = Number(args['api-port'] ?? 8101);
const API_FOR_BROWSER = `http://localhost:${API_PORT}`; // same site as the app, so the session cookie is sent
const API_FOR_NODE = `http://127.0.0.1:${API_PORT}`;
const OUT = path.resolve(ROOT, args.out ?? 'outputs/ui-audit-smoke');
const BIN = process.env.AIMEM_PLATFORM_BIN ?? path.join(PLATFORM, '.venv', 'bin');
// 'Run' queues real tool runs (formal and physical take ~10 min each); the self-test Run button is
// exercised in a dedicated flow below instead.
const SKIP_LABELS = new Set(['Sign out', 'Run', 'Running…']);
// Long repeated families (3D labels, timeline rows) are sampled, not exhaustively clicked.
const MAX_PER_FAMILY = 3;

const report = { app: APP, api: API_FOR_BROWSER, controls: [], failures: [], sessions: [], coverage: null, delivery: null, chain: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readDotenv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
  );
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

function fail(kind, detail) {
  report.failures.push({ kind, ...detail });
  console.error(`FAIL ${kind}: ${JSON.stringify(detail)}`);
}

// ---------------------------------------------------------------------------
// Platform API (test database only)
// ---------------------------------------------------------------------------
const dotenv = readDotenv(path.join(PLATFORM, '.env'));
const testDatabaseUrl = process.env.AIMEM_TEST_DATABASE_URL ?? dotenv.AIMEM_TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('AIMEM_TEST_DATABASE_URL is not set (run platform/scripts/setup-local-db.sh)');
const databaseName = new URL(testDatabaseUrl.replace('postgresql+psycopg', 'postgresql')).pathname.slice(1);
if (!databaseName.startsWith('aimem_platform') || !databaseName.endsWith('_test')) throw new Error(`refusing to run against ${databaseName}: use an aimem_platform*_test database`);

const alreadyRunning = await fetch(`${API_FOR_NODE}/api/health`).then(() => true, () => false);
if (alreadyRunning) throw new Error(`port ${API_PORT} is already serving; pick another --api-port so this run does not reuse a different API`);

const apiEnv = {
  ...process.env,
  AIMEM_DATABASE_URL: testDatabaseUrl,
  AIMEM_VAR_DIR: mkdtempSync(path.join(tmpdir(), 'aimem-ui-smoke-')),
  AIMEM_ENVIRONMENT: 'ui-smoke',
  AIMEM_CORS_ORIGINS: JSON.stringify([new URL(APP).origin]),
};
const api = spawn(path.join(BIN, 'uvicorn'), ['aimem_platform.app:create_app', '--factory', '--app-dir', PLATFORM, '--host', '127.0.0.1', '--port', String(API_PORT), '--log-level', 'warning'], {
  env: apiEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let apiOutput = '';
api.stdout.on('data', (chunk) => (apiOutput += chunk));
api.stderr.on('data', (chunk) => (apiOutput += chunk));
const stopApi = async () => {
  if (api.exitCode !== null) return;
  api.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => api.once('exit', resolve)), sleep(5000)]);
};

let browser;
try {
  await waitFor(async () => (await fetch(`${API_FOR_NODE}/api/health`)).ok, 30_000, 'the platform API to become healthy');

  const email = `ui-smoke-${Date.now()}@aimem.test`;
  const password = randomBytes(18).toString('base64url');
  const created = spawnSync(path.join(BIN, 'python'), ['-m', 'aimem_platform.cli', 'create-user', '--email', email, '--role', 'admin', '--name', 'UI smoke test', '--password-stdin'], {
    cwd: PLATFORM,
    env: apiEnv,
    input: `${password}\n`,
    encoding: 'utf8',
  });
  if (created.status !== 0) throw new Error(`could not create the smoke-test admin: ${created.stderr || created.stdout}`);
  const login = await fetch(`${API_FOR_NODE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aimem-client': 'cli' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`smoke-test login failed: ${login.status}`);
  const { token } = await login.json();
  const auth = { Authorization: `Bearer ${token}` };

  // -------------------------------------------------------------------------
  // Browser
  // -------------------------------------------------------------------------
  mkdirSync(OUT, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  await context.addInitScript((apiBase) => {
    try {
      window.localStorage.setItem('aimem.platformApi', apiBase);
    } catch {
      /* storage unavailable */
    }
  }, API_FOR_BROWSER);
  const page = await context.newPage();
  page.on('download', (download) => void download.delete().catch(() => undefined));
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const recorded = () => page.evaluate(() => window.__aimemAudit?.snapshot().counts.recorded ?? -1);
  const sessionId = () => page.evaluate(() => window.__aimemAudit.sessionId);
  const localEvents = () => page.evaluate(() => window.__aimemAudit.snapshot().events.map(({ event_id, feature, action, status, reason }) => ({ event_id, feature, action, status, reason })));
  const flushAll = () =>
    page.evaluate(async () => {
      for (let attempt = 0; attempt < 30 && window.__aimemAudit.snapshot().counts.queued; attempt += 1) {
        await window.__aimemAudit.retryNow();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return window.__aimemAudit.snapshot().counts;
    });
  const waitForApp = async () => {
    await page.waitForSelector('nav.view-tabs button', { timeout: 60_000 });
    await waitFor(() => page.evaluate(() => Boolean(window.__aimemAudit) && window.__aimemAudit.snapshot().counts.recorded > 0), 30_000, 'the audit client to start');
  };
  const activeTab = () => page.evaluate(() => document.querySelector('nav.view-tabs button.active')?.textContent?.trim() ?? '');
  const openTab = async (label) => {
    if ((await activeTab()) === label) return;
    await page.locator('nav.view-tabs').getByRole('button', { name: label, exact: true }).click();
    await waitFor(async () => (await activeTab()) === label, 5000, `the ${label} view`);
    await sleep(250);
  };
  // True once an event matching {feature, action?} is recorded after `before`.
  const newEventsSince = async (before, match, what, timeoutMs = 2500) => {
    try {
      await waitFor(
        () => page.evaluate(({ before, match }) => {
          const snapshot = window.__aimemAudit.snapshot();
          const fresh = snapshot.events.slice(0, Math.max(0, snapshot.counts.recorded - before));
          return fresh.some((event) => event.feature === match.feature && (!match.action || event.action === match.action));
        }, { before, match }),
        timeoutMs,
        what,
      );
      return true;
    } catch {
      return false;
    }
  };

  // --- Phase A: signed out. The sign-in form submit is recorded (dispatched; no password is typed).
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await waitForApp();
  const anonymousSession = await sessionId();
  await openTab('Activity');
  await page.waitForSelector('form.activity-login', { timeout: 10_000 });
  const beforeSubmit = await recorded();
  await page.evaluate(() => document.querySelector('form.activity-login').dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
  if (!(await newEventsSince(beforeSubmit, { feature: 'ui.interaction', action: 'submit' }, 'a submit event'))) fail('uninstrumented', { view: 'Activity', control: 'Sign in form (submit)' });
  const anonymousCounts = await flushAll();
  const anonymousLocal = await localEvents();
  report.sessions.push({ session: anonymousSession, signed_in: false, counts: anonymousCounts });

  // --- Phase B: signed in as the smoke admin; exercise every control in every view.
  await context.addCookies([{ name: 'aimem_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', secure: false }]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp();
  const session = await sessionId();
  const tabs = (await page.locator('nav.view-tabs button').allTextContents()).map((text) => text.trim());

  // Controls are identified by signature (tag, type, label, occurrence) rather than by
  // DOM node, because navigating away and back re-mounts panels as new nodes.
  const tagControls = () =>
    page.evaluate((maxPerFamily) => {
      const signatures = [];
      const seen = {};
      const families = {};
      for (const node of document.querySelectorAll('main.app-shell button, main.app-shell select, main.app-shell input, main.app-shell [data-audit]')) {
        node.removeAttribute('data-smoke-id');
        if (node.closest('nav.view-tabs')) continue;
        const family = node.getAttribute('data-audit') ?? (node.classList.contains('activity-row') ? 'activity-row' : null);
        if (family && (families[family] = (families[family] ?? 0) + 1) > maxPerFamily) continue;
        const label = (node.getAttribute('aria-label') || node.getAttribute('data-audit-label') || node.textContent || node.getAttribute('title') || node.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        // Digits are normalized so live counters ("This page (37)") do not look like new controls.
        const base = `${node.tagName.toLowerCase()}|${(node.getAttribute('type') || '').toLowerCase()}|${label.replace(/\d+/g, '#')}`;
        seen[base] = (seen[base] ?? 0) + 1;
        node.setAttribute('data-smoke-id', String(signatures.length));
        signatures.push(`${base}|#${seen[base]}`);
      }
      return signatures;
    }, MAX_PER_FAMILY);

  for (const tab of tabs) {
    await openTab(tab);
    await page.waitForTimeout(400);
    const visited = new Set();
    for (let step = 0; step < 600; step += 1) {
      await openTab(tab);
      const signatures = await tagControls();
      const id = signatures.findIndex((signature) => !visited.has(signature));
      if (id === -1) break;
      visited.add(signatures[id]);
      const element = page.locator(`[data-smoke-id="${id}"]`);
      if ((await element.count()) === 0 || !(await element.first().isVisible())) continue;
      const info = await element.first().evaluate((node) => ({
        tag: node.tagName.toLowerCase(),
        type: (node.getAttribute('type') || '').toLowerCase(),
        label: (node.getAttribute('aria-label') || node.getAttribute('data-audit-label') || node.textContent || node.getAttribute('title') || node.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        disabled: node.disabled === true,
        audit: node.getAttribute('data-audit'),
      }));
      if (info.disabled || SKIP_LABELS.has(info.label) || ['password', 'email', 'hidden'].includes(info.type)) {
        report.controls.push({ view: tab, control: info.label || info.tag, skipped: info.disabled ? 'disabled' : 'excluded' });
        continue;
      }
      const before = await recorded();
      let action = 'click';
      try {
        if (info.tag === 'select') {
          action = 'select';
          const choice = await element.first().evaluate((node) => [...node.options].find((option) => option.value !== node.value)?.value ?? node.value);
          await element.first().selectOption(choice);
        } else if (info.tag === 'input' && info.type === 'range') {
          // Step toward whichever end has room; a key press at the limit changes nothing and logs nothing.
          const atMax = await element.first().evaluate((node) => Number(node.value) >= Number(node.max || 100));
          action = atMax ? 'ArrowLeft' : 'ArrowRight';
          await element.first().focus();
          await page.keyboard.press(action);
        } else if (info.tag === 'input' && ['checkbox', 'radio'].includes(info.type)) {
          await element.first().click({ timeout: 3000 });
        } else if (info.tag === 'input') {
          action = 'type + blur';
          await element.first().fill('smoke');
          await element.first().evaluate((node) => node.blur());
        } else if (info.audit === 'twin-label' || info.audit === 'silicon-label') {
          // 3D labels track the camera, so they are never "stable" for a pointer click.
          action = 'dispatch click';
          await element.first().dispatchEvent('click');
        } else {
          await element.first().click({ timeout: 3000 }).catch(async () => {
            action = 'dispatch click (covered)';
            await element.first().dispatchEvent('click');
          });
        }
      } catch (error) {
        fail('interaction-error', { view: tab, control: info.label || info.tag, error: error.message.split('\n')[0] });
        continue;
      }
      const logged = await newEventsSince(before, { feature: 'ui.interaction' }, `an event for ${info.label}`);
      report.controls.push({ view: tab, control: info.label || info.tag, action, logged });
      if (!logged) fail('uninstrumented', { view: tab, control: info.label || info.tag, action });
      if (await page.evaluate(() => Boolean(document.fullscreenElement))) await page.evaluate(() => document.exitFullscreen());
    }
  }

  // --- Flows whose events arrive later or need a gesture rather than a click.
  const expectEvent = async (name, match, run, timeoutMs = 4000) => {
    const before = await recorded();
    await run();
    if (!(await newEventsSince(before, match, name, timeoutMs))) fail('missing-flow-event', { flow: name });
  };

  await openTab('3D design twin');
  // Start the drag where the canvas itself is topmost: 3D labels sit above it and take the pointer.
  const spot = await page.evaluate(() => {
    const canvas = document.querySelector('.twin-canvas canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    for (let fy = 0.2; fy <= 0.85; fy += 0.05) {
      for (let fx = 0.15; fx <= 0.85; fx += 0.05) {
        const x = rect.x + rect.width * fx;
        const y = rect.y + rect.height * fy;
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    }
    return null;
  });
  if (spot) {
    await expectEvent('3D camera gesture', { feature: 'ui.interaction', action: 'camera' }, async () => {
      await page.mouse.move(spot.x, spot.y);
      await page.mouse.down();
      await page.mouse.move(spot.x + 140, spot.y + 30, { steps: 12 });
      await page.mouse.up();
    });
  } else fail('missing-flow-event', { flow: 'no exposed point on the 3D canvas' });
  await expectEvent('twin part selected', { feature: 'ui.twin', action: 'part_selected' }, () => page.locator('[data-audit="twin-label"]').first().dispatchEvent('click'));
  await expectEvent('twin part cleared', { feature: 'ui.twin', action: 'part_cleared' }, () => page.getByRole('button', { name: 'Clear selected component' }).click());
  await expectEvent('keyboard shortcut', { feature: 'ui.interaction', action: 'key' }, () => page.keyboard.press('Escape'));

  // Runs: queue a sandbox self-test from the UI, execute it with a one-shot worker against the
  // test database, then rebuild it from the audit log in the UI.
  await openTab('Runs');
  await expectEvent('run queued from the UI', { feature: 'ui.interaction', action: 'click' }, () =>
    page.locator('.runs-card', { hasText: 'Sandbox self-test' }).getByRole('button', { name: 'Run', exact: true }).click(),
  );
  const worker = spawnSync(path.join(BIN, 'aimem-platform'), ['worker', '--once', '--runner', 'local'], { cwd: PLATFORM, env: apiEnv, encoding: 'utf8' });
  if (worker.status !== 0) fail('worker', { stderr: worker.stderr.slice(-1000) });
  await page.waitForSelector('.runs-detail', { timeout: 15_000 }).catch(() => fail('missing-flow-event', { flow: 'run detail did not open' }));
  await page.getByRole('button', { name: 'Rebuild from audit log' }).click();
  await page.waitForSelector('.runs-reconstruction.good', { timeout: 15_000 }).catch(() => fail('reconstruction', { detail: 'the UI did not report a consistent reconstruction' }));

  await openTab('Experiment');
  await expectEvent('sweep completed', { feature: 'ui.sweep', action: 'completed' }, () => page.getByRole('button', { name: /Run architecture sweep|Sweep complete|Running sweep/ }).first().click(), 8000);

  await openTab('Agent operations');
  const replay = page.locator('.stage-actions .primary-button');
  if ((await replay.textContent())?.includes('Pause')) await replay.click();
  await expectEvent('agent replay completed', { feature: 'ui.agent_replay', action: 'completed' }, () => replay.click(), 12_000);

  // --- Proof screenshots, then unload (records ui.session.ended via beacon).
  await openTab('Activity');
  await page.waitForSelector('.activity-row:not(.head)', { timeout: 15_000 }).catch(() => undefined);
  await page.screenshot({ path: path.join(OUT, 'activity.png'), fullPage: false });

  // Last, because a development error overlay can cover the page.
  await expectEvent('browser error', { feature: 'ui.error', action: 'error' }, () =>
    page.evaluate(() => setTimeout(() => { throw new Error('ui-audit smoke: synthetic uncaught error'); }, 0)),
  );
  await expectEvent('unhandled rejection', { feature: 'ui.error', action: 'unhandled_rejection' }, () =>
    page.evaluate(() => void Promise.reject(new Error('ui-audit smoke: synthetic unhandled rejection'))),
  );
  const counts = await flushAll();
  const signedInLocal = await localEvents();
  report.sessions.push({ session, signed_in: true, counts });
  await page.goto('about:blank');
  await sleep(1500);

  // -------------------------------------------------------------------------
  // Server-side verification
  // -------------------------------------------------------------------------
  const serverEvents = [];
  for (const id of [anonymousSession, session]) {
    let before = null;
    for (;;) {
      const url = `${API_FOR_NODE}/api/audit/events?source=ui&q=${id}&limit=500${before ? `&before_seq=${before}` : ''}`;
      const body = await (await fetch(url, { headers: auth })).json();
      serverEvents.push(...body.events);
      if (!body.next_before_seq) break;
      before = body.next_before_seq;
    }
  }
  const stored = new Set(serverEvents.map((event) => event.event_id));
  const local = [...anonymousLocal, ...signedInLocal];
  const undelivered = local.filter((event) => !stored.has(event.event_id));
  const rejected = local.filter((event) => event.status === 'rejected');
  report.delivery = { local_events: local.length, stored_events: serverEvents.length, undelivered: undelivered.length, rejected: rejected.map(({ feature, action, reason }) => ({ feature, action, reason })) };
  if (undelivered.length) fail('undelivered', { count: undelivered.length, sample: undelivered.slice(0, 5) });
  // The page buffer keeps the latest 1,000 events, so also reconcile the page's own counters:
  // every recorded event must be delivered or explicitly rejected, with nothing queued or dropped.
  for (const entry of report.sessions) {
    const { recorded, sent, rejected: refused, queued, dropped } = entry.counts;
    const storedForSession = serverEvents.filter((event) => event.details?.ui_session_id === entry.session).length;
    entry.stored = storedForSession;
    if (queued || dropped || sent + refused !== recorded || storedForSession < sent) fail('delivery-counters', { session: entry.session, ...entry.counts, stored: storedForSession });
  }
  if (rejected.length) fail('rejected', { events: report.delivery.rejected.slice(0, 10) });

  const registry = await (await fetch(`${API_FOR_NODE}/api/features`)).json();
  const observed = new Set(serverEvents.map((event) => `${event.feature}.${event.action}`));
  const required = registry.features.filter((feature) => feature.kind === 'ui').flatMap((feature) => feature.events.map((action) => `${feature.id}.${action}`));
  const missing = required.filter((name) => !observed.has(name));
  report.coverage = { required: required.length, observed: required.length - missing.length, missing };
  if (missing.length) fail('ui-coverage', { missing });

  const verification = await (await fetch(`${API_FOR_NODE}/api/audit/verify`, { method: 'POST', headers: auth })).json();
  report.chain = { ok: verification.ok, rows: verification.rows, head_seq: verification.head_seq };
  if (!verification.ok) fail('chain', { failures: verification.failures });

  const unexpectedErrors = pageErrors.filter((message) => !message.includes('ui-audit smoke'));
  if (unexpectedErrors.length) fail('page-errors', { errors: unexpectedErrors.slice(0, 5) });
} catch (error) {
  fail('crash', { error: error.stack ?? String(error), api_output: apiOutput.slice(-2000) });
} finally {
  await browser?.close();
  await stopApi();
}

const exercised = report.controls.filter((control) => !control.skipped);
report.summary = {
  controls_exercised: exercised.length,
  controls_logged: exercised.filter((control) => control.logged).length,
  controls_skipped: report.controls.length - exercised.length,
  failures: report.failures.length,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: report.summary, delivery: report.delivery, coverage: report.coverage, chain: report.chain, failures: report.failures.slice(0, 10) }, null, 2));
process.exit(report.failures.length ? 1 : 0);
