import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { CdpClient, type CdpProtocolTrace } from '../src/main/cdp-client';
import type { FingerprintConfig } from '../src/types';

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') throw new Error('Disposable Linux Actions browser gate only');
const binary = process.env.LYCO_BROWSER_EXE;
if (!binary || !path.isAbsolute(binary)) throw new Error('Pinned browser dependency is missing');

interface PageReading { userAgent: string; language: string; timezone: string; platform: string; cores: number }
interface Reading { requests: number; reports: number; ua?: string; language?: string; fixtureCookie?: boolean; page?: PageReading }
const readings = new Map<string, Reading>();
const evidence: {
  source: string | undefined; run: string | undefined; productAcceptance: false;
  version: string; binarySha256: string; cases: { name: string; status: string; first?: Reading; fatalError?: string; protocol?: CdpProtocolTrace[] }[];
  protocolControls?: { interception: boolean; beforeAbort: string[]; afterAbort: string[] }[];
} = { source: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, productAcceptance: false,
  version: '', binarySha256: '', cases: [] };
let origin = '';
const fixture = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://owned.invalid');
  if (url.pathname === '/prime') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store',
      'Set-Cookie': 'lyco_owned_fixture=owned; Path=/; SameSite=Lax' });
    res.end('<!doctype html><title>Owned cookie fixture</title>'); return;
  }
  const name = url.searchParams.get('case');
  if (!name || !['initial', 'new-page', 'invalid-configuration', 'new-page-invalid-configuration'].includes(name)) { res.writeHead(404); res.end(); return; }
  const row = readings.get(name) || { requests: 0, reports: 0 }; readings.set(name, row);
  if (url.pathname === '/first') {
    row.requests++;
    if (row.requests === 1) {
      row.ua = String(req.headers['user-agent'] || '').slice(0, 512);
      row.language = String(req.headers['accept-language'] || '').slice(0, 160);
      row.fixtureCookie = String(req.headers.cookie || '').split(';').some(part => part.trim() === 'lyco_owned_fixture=owned');
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><title>Owned startup fixture</title><script>'
      + 'const first={userAgent:navigator.userAgent,language:navigator.language,platform:navigator.platform,'
      + 'cores:navigator.hardwareConcurrency,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};'
      + `fetch('/report?case=${name}',{method:'POST',body:JSON.stringify(first)});</script>`);
    return;
  }
  if (url.pathname !== '/report' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    try { const value = JSON.parse(body) as PageReading; row.reports++; if (row.reports === 1) row.page = value; res.end('ok'); }
    catch { res.writeHead(400); res.end(); }
  });
});

beforeAll(async () => {
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  evidence.binarySha256 = hash.digest('hex');
});
afterAll(async () => {
  await fs.writeFile('browser-observations.json', JSON.stringify(evidence, null, 2));
  await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
});

const fingerprint: FingerprintConfig = {
  timezone: 'Europe/Paris', language: 'fr-FR', latitude: 0, longitude: 0,
  canvasSeed: 1, webglSeed: 1, hardwareConcurrency: 4, screenWidth: 1280, screenHeight: 720,
  colorDepth: 24, deviceMemory: 4, screenRefreshRate: 60, platform: 'Linux x86_64', architecture: 'x86',
  maxTouchPoints: 0, devicePixelRatio: 1, networkEffectiveType: '4g', batteryCharging: true,
  batteryLevel: 1, gpuVendor: 'CI-only fixture', gpuRenderer: 'CI-only fixture',
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withBrowser(name: string, timezone: string, check: (client: CdpClient, ua: string, browserUrl: string, settings: FingerprintConfig) => Promise<void>): Promise<void> {
  const row = { name, status: 'running' } as typeof evidence.cases[number]; evidence.cases.push(row);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lyco-real-browser-'));
  const child = spawn(binary, [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost', 'about:blank',
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
    TZ: 'UTC', LD_LIBRARY_PATH: process.env.LYCO_BROWSER_LIBS || '' } });
  let spawnError = false; child.once('error', () => { spawnError = true; });
  // Drain without publishing arbitrary browser diagnostics or profile contents.
  child.stderr?.resume();
  let client: CdpClient | undefined;
  try {
    let port = 0, browserPath = '';
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw new Error('Browser exited before loopback CDP readiness');
      try {
        const lines = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
        port = Number(lines[0]); browserPath = lines[1];
        if (Number.isInteger(port) && port > 1023 && port < 65536 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath)) break;
      } catch { /* startup file is not ready */ }
      await pause(50);
    }
    expect(port).toBeGreaterThan(1023);
    expect(browserPath).toMatch(/^\/devtools\/browser\/[A-Za-z0-9-]+$/);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { Browser: string; 'User-Agent': string };
    expect(version.Browser).toContain('156.0.8078.47');
    expect(version['User-Agent']).toBeTypeOf('string');
    expect(version['User-Agent']).toContain('Chrome/');
    evidence.version = version.Browser;
    const ua = version['User-Agent'] + ' LYCO-FirstNavigation-Contract/1.0';
    const settings = { ...fingerprint, timezone };
    row.protocol = [];
    client = new CdpClient(port, settings, ua, undefined,
      error => { row.fatalError = error.message.slice(0, 240); }, event => {
        if (row.protocol!.length >= 256) return;
        const idHash = (value: string | undefined) => value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : undefined;
        row.protocol!.push({ ...event, sessionId: idHash(event.sessionId),
          parentSessionId: idHash(event.parentSessionId), targetId: idHash(event.targetId) });
      });
    await check(client, ua, `ws://127.0.0.1:${port}${browserPath}`, settings);
    row.status = 'passed';
  } catch (error) { row.status = 'failed'; throw error; }
  finally {
    row.first = readings.get(name);
    client?.close();
    if (child.pid) {
      // Only the process group created by this test, never a name-based kill.
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 3000;
      while (child.exitCode === null && Date.now() < deadline) await pause(25);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function firstReading(name: string, ua: string): Promise<void> {
  await vi.waitFor(() => expect(readings.get(name)?.page).toBeDefined(), { timeout: 10000, interval: 25 });
  const row = readings.get(name)!;
  expect(row.requests).toBe(1); expect(row.reports).toBe(1);
  expect(row.ua).toBe(ua); expect(row.language).toBe(fingerprint.language);
  if (name === 'new-page') expect(row.fixtureCookie).toBe(true);
  expect(row.page).toEqual({ userAgent: ua, language: fingerprint.language, platform: fingerprint.platform,
    cores: fingerprint.hardwareConcurrency, timezone: fingerprint.timezone });
}

async function createTarget(browserUrl: string, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(browserUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Owned target creation timed out')); }, 5000);
    const finish = (error?: Error) => { clearTimeout(timer); ws.close(); if (error) reject(error); else resolve(); };
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } })));
    ws.on('error', finish);
    ws.on('message', data => {
      const reply = JSON.parse(data.toString()) as { id?: number; result?: { targetId?: string }; error?: unknown };
      if (reply.id === 1) finish(reply.error || !reply.result?.targetId ? new Error('Owned target creation failed') : undefined);
    });
  });
}

test('initial navigation uses the configured first request and synchronous first-script values', async () => {
  await withBrowser('initial', fingerprint.timezone, async (client, ua) => {
    await expect(client.navigate(origin + '/first?case=initial')).rejects.toThrow('No configured page');
    expect(readings.has('initial')).toBe(false);
    await client.connect(); expect(readings.has('initial')).toBe(false);
    await client.navigate(origin + '/first?case=initial');
    await firstReading('initial', ua);
  });
});

test('an ordinary new target retains configured values on its first request and script', async () => {
  await withBrowser('new-page', fingerprint.timezone, async (client, ua, browserUrl) => {
    await client.connect();
    await client.navigate(origin + '/prime');
    await vi.waitFor(async () => {
      const value = await client.runScript('document.cookie');
      expect(value.result).toContain('lyco_owned_fixture=owned');
    }, { timeout: 5000, interval: 50 });
    await createTarget(browserUrl, origin + '/first?case=new-page');
    await firstReading('new-page', ua);
  });
});

test('a real required-command refusal prevents initial navigation', async () => {
  await withBrowser('invalid-configuration', 'LYCO-Invalid/Fixture', async client => {
    await expect(client.connect()).rejects.toThrow('Invalid timezone id');
    await expect(client.navigate(origin + '/first?case=invalid-configuration')).rejects.toThrow('No configured page');
    expect(readings.has('invalid-configuration')).toBe(false);
  });
});

test('a required-command refusal on a new target aborts its held first request', async () => {
  const name = 'new-page-invalid-configuration';
  await withBrowser(name, fingerprint.timezone, async (client, _ua, browserUrl, settings) => {
    await client.connect();
    // Fault injection through the same config object, not a mocked transport.
    settings.timezone = 'LYCO-Invalid/Fixture';
    await createTarget(browserUrl, origin + '/first?case=' + name);
    await vi.waitFor(() => expect(evidence.cases.find(row => row.name === name)?.fatalError).toContain('Invalid timezone id'),
      { timeout: 15000, interval: 25 });
    expect(readings.has(name)).toBe(false);
    await expect(client.navigate(origin + '/first?case=' + name)).rejects.toThrow('No configured page');
  });
});

// Transport diagnosis only: no fingerprint configuration, application source,
// detector, credentials or public URLs. Existing acceptance tests stay intact.
test('records renderer startup acknowledgements with and without a held document', async () => {
  evidence.protocolControls = [];
  for (const interception of [true, false]) {
    await withBrowser('protocol-control', fingerprint.timezone, async (_client, _ua, browserUrl) => {
      const ws = new WebSocket(browserUrl);
      const commands = new Map<number, string>();
      const responses: string[] = [];
      let nextId = 0, session = '', request = '';
      const send = (method: string, params: object = {}, sessionId?: string) => {
        const id = ++nextId; commands.set(id, method);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      };
      ws.on('message', data => {
        const msg = JSON.parse(data.toString()) as { id?: number; method?: string;
          error?: unknown; params?: { sessionId?: string; requestId?: string; targetInfo?: { type: string } } };
        if (msg.id !== undefined) responses.push((msg.error ? 'error:' : 'ok:') + commands.get(msg.id));
        if (msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo?.type === 'page') session = msg.params.sessionId!;
        if (msg.method === 'Fetch.requestPaused') request = msg.params!.requestId!;
      });
      try {
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        // Existing blank page is deliberately excluded: diagnose a NEW renderer.
        send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        await vi.waitFor(() => expect(responses).toContain('ok:Target.setAutoAttach'));
        session = '';
        await createTarget(browserUrl, origin + '/prime');
        await vi.waitFor(() => expect(session).not.toBe(''));
        if (interception) {
          send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, session);
          await vi.waitFor(() => expect(responses).toContain('ok:Fetch.enable'));
        }
        send('Runtime.enable', {}, session);
        send('Page.enable', {}, session);
        send('Emulation.setTimezoneOverride', { timezoneId: 'Etc/UTC' }, session);
        send('Page.addScriptToEvaluateOnNewDocument', { source: '/* owned startup control */' }, session);
        send('Runtime.runIfWaitingForDebugger', {}, session);
        await pause(1500);
        const beforeAbort = [...responses];
        if (interception) {
          expect(request).not.toBe('');
          send('Fetch.failRequest', { requestId: request, errorReason: 'Aborted' }, session);
        }
        await pause(1000);
        evidence.protocolControls!.push({ interception, beforeAbort, afterAbort: [...responses] });
        if (!interception) expect(responses).toContain('ok:Runtime.runIfWaitingForDebugger');
      } finally { ws.close(); }
    });
  }
});
