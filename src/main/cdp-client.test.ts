import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FingerprintConfig } from '../types';

interface Command { id: number; method: string; params: Record<string, unknown>; sessionId?: string }
const h = vi.hoisted(() => ({
  commands: [] as Command[], sockets: [] as (EventEmitter & { readyState: number })[],
  autoAttach: true, targets: [{ targetId: 'page-one', type: 'page', url: 'about:blank' }],
  refused: '', scriptException: false, delayedMethod: '', delayedSession: '', delay: null as Promise<void> | null,
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
      let result: unknown = {};
      if (command.method === 'Target.getTargets') result = { targetInfos: h.targets };
      if (command.method === 'Target.attachToTarget') result = { sessionId: 'session-one' };
      if (command.method === 'Runtime.evaluate' && h.scriptException) result = { exceptionDetails: { text: 'private script detail' } };
      if (command.method === 'Page.navigate' && h.scriptException) result = { errorText: 'private navigation detail' };
      this.emit('message', JSON.stringify(command.method === h.refused
        ? { id: command.id, error: { code: -32000, message: 'Synthetic required-command refusal' } }
        : { id: command.id, result }));
    });
  }
  close(): void { this.readyState = 3; this.emit('close'); }
  } };
});

import { CdpClient } from './cdp-client';

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
  client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test');
});
afterEach(() => { client.close(); });

function attached(sessionId: string, targetId: string, waitingForDebugger = false): void {
  h.sockets[0].emit('message', JSON.stringify({ method: 'Target.attachedToTarget', params: {
    sessionId, targetInfo: { targetId, type: 'page' }, waitingForDebugger,
  } }));
}

describe('CDP required page-configuration barrier (no real browser or detector)', () => {
  it('registers a new-document script and resumes a debugger-waiting page without evaluating a nonexistent context', async () => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect(); h.refused = 'Runtime.evaluate';
    attached('session-two', 'page-two', true);
    await vi.waitFor(() => expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(true));
    const commands = h.commands.filter(command => command.sessionId === 'session-two').map(command => command.method);
    expect(commands).toContain('Page.addScriptToEvaluateOnNewDocument');
    expect(commands).not.toContain('Runtime.evaluate');
    expect(commands.indexOf('Runtime.runIfWaitingForDebugger')).toBeGreaterThan(commands.indexOf('Page.addScriptToEvaluateOnNewDocument'));
    expect(fatal).not.toHaveBeenCalled();
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

  it('ignores a detached pending page without treating its late setup result as readiness', async () => {
    const fatal = vi.fn();
    client = new CdpClient(9222, fingerprint, 'LYCO-Startup-Contract-Test', undefined, fatal);
    await client.connect();
    let finish!: () => void;
    h.delayedMethod = 'Network.enable'; h.delayedSession = 'session-two';
    h.delay = new Promise<void>(resolve => { finish = resolve; });
    attached('session-two', 'page-two');
    await vi.waitFor(() => expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Network.enable')).toBe(true));
    h.sockets[0].emit('message', JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'session-two' } }));
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fatal).not.toHaveBeenCalled();
    expect(h.commands.some(command => command.sessionId === 'session-two' && command.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
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
