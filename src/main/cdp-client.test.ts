import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FingerprintConfig } from '../types';

interface Command { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
const h = vi.hoisted(() => ({
  commands: [] as Command[], sockets: [] as (EventEmitter & { readyState: number })[],
  autoAttach: true, targets: [{ targetId: 'page-one', type: 'page', url: 'about:blank' }],
  refused: '', scriptException: false, delayedMethod: '', delayedSession: '', delay: null as Promise<void> | null,
  pauseDocument: false, requireResume: false, resumed: new Set<string>(),
}));

vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: { get: (_url: string, respond: (response: EventEmitter) => void) => {
  const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
  queueMicrotask(() => {
    const response = new EventEmitter(); respond(response);
    response.emit('data', JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/owned' }));
    response.emit('end');
  });
  return request;
  } } };
});

vi.mock('./fingerprint', () => ({
  buildFingerprintScript: () => '/* CI configuration fixture; no page properties modified */',
  getPlatformVersionForUserAgentData: () => '15.0.0',
}));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  constructor(_url: string) {
    super(); h.sockets.push(this);
    queueMicrotask(() => this.emit('open'));
  }
  send(raw: string): void {
    const command = JSON.parse(raw) as Command;
    h.commands.push(command);
    queueMicrotask(async () => {
      if (command.method === 'Target.setAutoAttach' && h.autoAttach) {
        this.emit('message', JSON.stringify({ method: 'Target.attachedToTarget', params: {
          sessionId: 'session-one', targetInfo: { targetId: 'page-one', type: 'page' },
        } }));
      }
      if (command.method === h.delayedMethod && (!h.delayedSession || command.sessionId === h.delayedSession)) await h.delay;
      if (this.readyState !== FakeSocket.OPEN) return;
      if (command.method === 'Fetch.enable' && h.pauseDocument && h.refused !== 'Fetch.enable') {
        this.emit('message', JSON.stringify({ method: 'Fetch.requestPaused', sessionId: command.sessionId, params: {
          requestId: 'owned-document', request: { headers: { 'User-Agent': 'unconfigured', 'Accept-Language': 'unconfigured-language',
            Cookie: 'owned_cookie=1', Authorization: 'Bearer owned-fixture', Accept: 'text/html' } },
        } }));
      }
      if (command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId) h.resumed.add(command.sessionId);
      let result: unknown = {};
      if (command.method === 'Target.getTargets') result = { targetInfos: h.targets };
      if (command.method === 'Target.attachToTarget') result = { sessionId: 'session-one' };
      if (command.method === 'Runtime.evaluate' && h.scriptException) result = { exceptionDetails: { text: 'private script detail' } };
      if (command.method === 'Page.navigate' && h.scriptException) result = { errorText: 'private navigation detail' };
      const prematureRuntime = h.requireResume && command.method === 'Runtime.enable' && !h.resumed.has(command.sessionId || '');
      this.emit('message', JSON.stringify(command.method === h.refused || prematureRuntime
        ? { id: command.id, error: { code: -32000, message: 'Synthetic required-command refusal' } }
        : { id: command.id, result }));
    });
  }
  close(): void { this.readyState = 3; this.emit('close'); }
  } };
});

import { CdpClient, type CdpProtocolTrace } from './cdp-client';

const fingerprint: FingerprintConfig = {
  timezone: 'Etc/UTC', language: 'en-US', latitude: 0, longitude: 0,
  canvasSeed: 1, webglSeed: 1, hardwareConcurrency: 4, screenWidth: 1280, screenHeight: 720,
  colorDepth: 24, deviceMemory: 4, screenRefreshRate: 60, platform: 'Win32', architecture: 'x86',
  maxTouchPoints: 0, devicePixelRatio: 1, networkEffectiveType: '4g', batteryCharging: true,
  batteryLevel: 1, gpuVendor: 'CI fixture', gpuRenderer: 'CI fixture',
};
let client: CdpClient;
beforeEach(() => {
  h.commands = []; h.sockets = []; h.autoAttach = true;
  h.targets = [{ targetId: 'page-one', type: 'page', url: 'about:blank' }];
  h.refused = ''; h.scriptException = false; h.delayedMethod = ''; h.delayedSession = ''; h.delay = null;
  h.pauseDocument = false; h.requireResume = false; h.resumed = new Set();
  client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test');
});
afterEach(() => { client.close(); });

function attached(sessionId: string, targetId: string, waitingForDebugger = false): void {
  h.sockets[0].emit('message', JSON.stringify({ method: 'Target.attachedToTarget', params: {
    sessionId, targetInfo: { targetId, type: 'page' }, waitingForDebugger,
  } }));
}

describe('CDP required page-configuration barrier (no real browser or detector)', () => {
  it('isolates an opt-in protocol observer and never gives it parameters or credentials', async () => {
    const traces: CdpProtocolTrace[] = [];
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, undefined, event => {
      traces.push(event);
      if (event.kind === 'command') throw new Error('Observer must not control transport');
    });
    await client.connect(); h.pauseDocument = true; attached('session-two', 'page-two', true);
    await vi.waitFor(() => expect(h.commands.some(command => command.method === 'Fetch.continueRequest')).toBe(true));
    h.refused = 'Page.navigate';
    await expect(client.navigate('https://owned-fixture.invalid/private-query')).rejects.toThrow();
    expect(traces.some(event => event.kind === 'command' && event.method === 'Fetch.continueRequest')).toBe(true);
    expect(traces.some(event => event.kind === 'response' && event.method === 'Page.navigate' && event.errorCode === -32000)).toBe(true);
    expect(JSON.stringify(traces)).not.toMatch(/private-query|owned_cookie|owned-fixture|Authorization|CI configuration fixture|Synthetic required-command refusal/);
  });

  it('holds document requests while resuming a waiting renderer and configuring its future document', async () => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect(); h.refused = 'Runtime.evaluate'; h.requireResume = true; h.pauseDocument = true;
    attached('session-two', 'page-two', true);
    await vi.waitFor(() => expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Fetch.continueRequest')).toBe(true));
    const commands = h.commands.filter(command => command.sessionId === 'session-two').map(command => command.method);
    expect(commands).toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(commands).not.toContain('Runtime.evaluate');
    expect(commands.indexOf('Runtime.runIfWaitingForDebugger')).toBeGreaterThan(commands.indexOf('Fetch.enable'));
    expect(commands.indexOf('Runtime.enable')).toBeGreaterThan(commands.indexOf('Runtime.runIfWaitingForDebugger'));
    expect(commands.indexOf('Fetch.continueRequest')).toBeGreaterThan(commands.indexOf('Page.addScriptToEvaluateOnNewDocument'));
    const request = h.commands.find(command => command.method === 'Fetch.continueRequest')!;
    expect(request.params.headers).toEqual(expect.arrayContaining([
      { name: 'User-Agent', value: 'LYCO-Startup-Contract-Test' }, { name: 'Accept-Language', value: 'en-US' },
      { name: 'Cookie', value: 'owned_cookie=1' }, { name: 'Authorization', value: 'Bearer owned-fixture' },
      { name: 'Accept', value: 'text/html' },
    ]));
    expect(fatal).not.toHaveBeenCalled();
  });

  it('aborts the held navigation when a required configuration command fails after renderer resume', async () => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect(); h.pauseDocument = true; h.refused = 'Emulation.setTimezoneOverride';
    attached('session-two', 'page-two', true);
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1));
    expect(h.commands.some(command => command.method === 'Fetch.failRequest' && command.params.requestId === 'owned-document')).toBe(true);
    expect(h.commands.some(command => command.method === 'Page.stopLoading')).toBe(true);
    expect(h.commands.some(command => command.method === 'Fetch.continueRequest')).toBe(false);
  });

  it('cannot resume a new renderer if its document request gate is rejected', async () => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect(); h.refused = 'Fetch.enable';
    attached('session-two', 'page-two', true);
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1));
    expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
  });

  it('also protects the first document when a new blank page has no request during setup', async () => {
    await client.connect(); attached('session-two', 'page-two', true);
    await vi.waitFor(() => expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.commands.some(command => command.method === 'Fetch.continueRequest')).toBe(false);
    h.sockets[0].emit('message', JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'session-two', params: {
      requestId: 'later-document', request: { headers: { Accept: 'text/html' } },
    } }));
    await vi.waitFor(() => expect(h.commands.some(command => command.method === 'Fetch.continueRequest' && command.params.requestId === 'later-document')).toBe(true));
  });

  it('waits for required configuration before resuming or allowing initial navigation', async () => {
    let configured!: () => void;
    h.delayedMethod = 'Page.addScriptToEvaluateOnNewDocument';
    h.delay = new Promise<void>(resolve => { configured = resolve; });
    const connecting = client.connect();
    await vi.waitFor(() => expect(h.commands.some(command => command.method === h.delayedMethod)).toBe(true));
    expect(h.commands.some(command => command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    await expect(client.navigate('https://owned-fixture.invalid/start')).rejects.toThrow('No configured page');
    configured(); await connecting;
    await client.navigate('https://owned-fixture.invalid/start');
    const resume = h.commands.findIndex(command => command.method === 'Runtime.runIfWaitingForDebugger');
    const navigation = h.commands.findIndex(command => command.method === 'Page.navigate');
    expect(resume).toBeGreaterThan(h.commands.findIndex(command => command.method === 'Runtime.evaluate'));
    expect(navigation).toBeGreaterThan(resume);
    expect(h.commands[navigation].params.url).toBe('https://owned-fixture.invalid/start');
    // The auto-attach event and target enumeration must await the same setup.
    expect(h.commands.filter(command => command.method === 'Runtime.enable')).toHaveLength(1);
  });

  it('rejects startup rather than resuming a page whose required command failed', async () => {
    h.refused = 'Emulation.setTimezoneOverride';
    await expect(client.connect()).rejects.toThrow('Synthetic required-command refusal');
    expect(h.commands.some(command => command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    expect(h.commands.some(command => command.method === 'Page.navigate')).toBe(false);
    expect(h.sockets[0].readyState).toBe(3);
  });

  it('rejects an acknowledged script evaluation that reports an exception', async () => {
    h.scriptException = true;
    await expect(client.connect()).rejects.toThrow('Page configuration script failed');
    expect(h.commands.some(command => command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
  });

  it('cannot report a successful connection with no configured page target', async () => {
    h.autoAttach = false; h.targets = [];
    await expect(client.connect()).rejects.toThrow('No configured page');
    expect(h.sockets[0].readyState).toBe(3);
  });

  it('propagates a later page configuration failure to the owned environment once', async () => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect();
    h.refused = 'Network.enable'; attached('session-two', 'page-two');
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1));
    expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    expect(h.sockets[0].readyState).toBe(3);
  });

  it.each(['Network.enable', 'Fetch.continueRequest'])('ignores a page detached during %s without promoting its late result to readiness', async method => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect();
    let finish!: () => void;
    h.delayedMethod = method; h.delayedSession = 'session-two'; h.pauseDocument = method === 'Fetch.continueRequest';
    h.delay = new Promise<void>(resolve => { finish = resolve; });
    attached('session-two', 'page-two', h.pauseDocument);
    await vi.waitFor(() => expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === method)).toBe(true));
    h.sockets[0].emit('message', JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-two' } }));
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fatal).not.toHaveBeenCalled();
    if (!h.pauseDocument) expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    await client.navigate('https://owned-fixture.invalid/still-owned');
    expect(h.commands.filter(command => command.method === 'Page.navigate').at(-1)?.sessionId).toBe('session-one');
  });

  it('checks navigation errorText even when the CDP command itself is acknowledged', async () => {
    await client.connect(); h.scriptException = true;
    await expect(client.navigate('https://owned-fixture.invalid/start')).rejects.toThrow('Initial page navigation failed');
  });

  it('preserves optional non-page setup without promoting a worker to a configured page', async () => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect(); h.refused = 'Page.enable';
    h.sockets[0].emit('message', JSON.stringify({ method: 'Target.attachedToTarget', params: {
      sessionId: 'worker-session', targetInfo: { targetId: 'worker-target', type: 'worker' },
    } }));
    await vi.waitFor(() => expect(h.commands.some(command => command.sessionId === 'worker-session' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(true));
    expect(h.commands.some(command => command.sessionId === 'worker-session' && command.method === 'Emulation.setUserAgentOverride')).toBe(true);
    expect(fatal).not.toHaveBeenCalled();
    await client.navigate('https://owned-fixture.invalid/page');
    expect(h.commands.filter(command => command.method === 'Page.navigate').at(-1)?.sessionId).toBe('session-one');
  });
});
