import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../types';

const h = vi.hoisted(() => ({
  spawn: vi.fn(), connect: vi.fn(), navigate: vi.fn(), stopProxy: vi.fn(), httpGet: vi.fn(), createServer: vi.fn(),
  clients: [] as { connect: () => Promise<void>; close: ReturnType<typeof vi.fn> }[],
  fatalCallbacks: [] as (() => void)[],
  children: [] as (EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> })[],
  responses: [] as ((response: EventEmitter) => void)[],
}));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('node:net', () => ({ default: { createServer: h.createServer } }));
vi.mock('node:http', () => ({ default: { get: h.httpGet } }));
vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn() } }));
vi.mock('electron', () => ({ app: { getPath: () => 'Z:/owned-ci-profile' } }));
vi.mock('./mihomo-manager', () => ({
  stopMihomoForEnv: h.stopProxy, startMihomoForEnv: vi.fn(),
  isMihomoRunning: vi.fn(), probeEnvNode: vi.fn(),
}));
vi.mock('./cdp-client', () => ({ CdpClient: class {
  connect = () => h.connect();
  navigate = (url: string) => h.navigate(url);
  close = vi.fn();
  constructor(_port: number, _fp: unknown, _ua: string, _hooks: unknown, onFatal: () => void) {
    h.clients.push(this); h.fatalCallbacks.push(onFatal);
  }
} }));

import { closeAll, closeEnv, getCdpClient, getRuntime, launchEnv } from './chrome-manager';

function environment(id = 'owned-environment'): Environment {
  return { id, name: id, createdAt: '', userAgent: 'LYCO-Lifecycle-Test',
    // Fingerprint contents are irrelevant to transport lifecycle; no browser is
    // executed by these unit tests and no fingerprint success is asserted.
    fingerprint: {} as Environment['fingerprint'], proxyMode: 'simple',
    proxySimple: 'http://127.0.0.1:3128', proxySourceId: '', proxyNodeId: '', notes: '' };
}

function devToolsReady(): void {
  const respond = h.responses.shift();
  if (!respond) throw new Error('No owned DevTools request awaiting a response');
  const response = new EventEmitter(); respond(response);
  response.emit('data', '{}'); response.emit('end');
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks(); h.clients = []; h.children = []; h.responses = []; h.fatalCallbacks = [];
  h.connect.mockReset().mockResolvedValue(undefined);
  h.navigate.mockReset().mockResolvedValue(undefined);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 100 + h.children.length, kill: vi.fn() });
    h.children.push(child); return child;
  });
  h.createServer.mockImplementation(() => {
    const server = Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, ready: () => void) => { queueMicrotask(ready); },
      close: (closed: () => void) => { closed(); },
    });
    return server;
  });
  h.httpGet.mockImplementation((_url: string, respond: (response: EventEmitter) => void) => {
    h.responses.push(respond);
    return Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
  });
});
afterEach(() => { closeAll(); errorLog.mockRestore(); });

describe('Chrome initialization ownership and failure cleanup', () => {
  it('launches only a blank page and waits for configuration before opening the home page', async () => {
    let configured!: () => void;
    h.connect.mockImplementationOnce(() => new Promise<void>(resolve => { configured = resolve; }));
    const home = 'https://owned-fixture.invalid/start';
    await launchEnv(environment(), 'chrome-test.exe', home);
    expect(h.spawn.mock.calls[0][1]).toContain('about:blank');
    expect(h.spawn.mock.calls[0][1]).not.toContain(home);
    devToolsReady();
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    expect(h.navigate).not.toHaveBeenCalled();
    configured();
    await vi.waitFor(() => expect(h.navigate).toHaveBeenCalledWith(home));
    await vi.waitFor(() => expect(getCdpClient('owned-environment')).toBe(h.clients[0]));
  });

  it('closes the owned environment if the configured initial navigation fails', async () => {
    h.navigate.mockRejectedValueOnce(new Error('Initial navigation refused'));
    const status = vi.fn();
    await launchEnv(environment(), 'chrome-test.exe', 'https://owned-fixture.invalid/start', status);
    devToolsReady();
    await vi.waitFor(() => expect(getRuntime('owned-environment')).toBeNull());
    expect(h.children[0].kill).toHaveBeenCalledTimes(1);
    expect(h.clients[0].close).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('owned-environment', { envId: 'owned-environment', running: false });
  });

  it('cancellation during configuration cannot open the old home page', async () => {
    let configured!: () => void;
    h.connect.mockImplementationOnce(() => new Promise<void>(resolve => { configured = resolve; }));
    await launchEnv(environment(), 'chrome-test.exe', 'https://owned-fixture.invalid/old'); devToolsReady();
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    closeEnv('owned-environment'); configured();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.navigate).not.toHaveBeenCalled();
    expect(getCdpClient('owned-environment')).toBeNull();
  });

  it('a later configuration failure closes only its owned environment', async () => {
    await launchEnv(environment(), 'chrome-test.exe'); devToolsReady();
    await vi.waitFor(() => expect(getCdpClient('owned-environment')).toBe(h.clients[0]));
    const oldFatal = h.fatalCallbacks[0];
    oldFatal();
    expect(getRuntime('owned-environment')).toBeNull();
    expect(h.children[0].kill.mock.invocationCallOrder[0]).toBeLessThan(h.clients[0].close.mock.invocationCallOrder[0]);
    await launchEnv(environment(), 'chrome-test.exe'); devToolsReady();
    await vi.waitFor(() => expect(getCdpClient('owned-environment')).toBe(h.clients[1]));
    oldFatal();
    expect(h.children[1].kill).not.toHaveBeenCalled();
    expect(getCdpClient('owned-environment')).toBe(h.clients[1]);
  });

  it('closes the browser, client and proxy when the initialization connection rejects', async () => {
    h.connect.mockRejectedValueOnce(new Error('CDP connection failed'));
    const status = vi.fn();
    await launchEnv(environment(), 'chrome-test.exe', undefined, status);
    devToolsReady();
    await vi.waitFor(() => expect(getRuntime('owned-environment')).toBeNull());
    expect(h.children[0].kill).toHaveBeenCalledTimes(1);
    expect(h.clients[0].close).toHaveBeenCalled();
    expect(h.stopProxy).toHaveBeenCalledWith('owned-environment');
    expect(status).toHaveBeenLastCalledWith('owned-environment', { envId: 'owned-environment', running: false });
  });

  it('keeps a successfully connected environment running', async () => {
    await launchEnv(environment(), 'chrome-test.exe'); devToolsReady();
    await vi.waitFor(() => expect(getCdpClient('owned-environment')).toBe(h.clients[0]));
    expect(getCdpClient('owned-environment')).toBe(h.clients[0]);
    expect(getRuntime('owned-environment')?.running).toBe(true);
    expect(h.children[0].kill).not.toHaveBeenCalled();
  });

  it('does not create a client when the user closes before DevTools becomes ready', async () => {
    const status = vi.fn();
    await launchEnv(environment(), 'chrome-test.exe', undefined, status);
    closeEnv('owned-environment'); devToolsReady();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.clients).toHaveLength(0);
    expect(getRuntime('owned-environment')).toBeNull();
    expect(status).toHaveBeenLastCalledWith('owned-environment', { envId: 'owned-environment', running: false });
  });

  it('does not expose a still-connecting client through the public runtime API', async () => {
    let finish!: () => void;
    h.connect.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await launchEnv(environment(), 'chrome-test.exe'); devToolsReady();
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    expect(getCdpClient('owned-environment')).toBeNull();
    finish();
    await vi.waitFor(() => expect(getCdpClient('owned-environment')).toBe(h.clients[0]));
    expect(h.children[0].kill).not.toHaveBeenCalled();
  });

  it('a late connection rejection cannot close a replacement with the same environment id', async () => {
    let rejectOld!: (error: Error) => void;
    h.connect.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    await launchEnv(environment(), 'chrome-test.exe'); devToolsReady();
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    closeEnv('owned-environment');
    await launchEnv(environment(), 'chrome-test.exe'); devToolsReady();
    await vi.waitFor(() => expect(getCdpClient('owned-environment')).toBe(h.clients[1]));
    rejectOld(new Error('late old connection failure'));
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledTimes(1));
    expect(h.children[1].kill).not.toHaveBeenCalled();
    expect(getCdpClient('owned-environment')).toBe(h.clients[1]);
    expect(getRuntime('owned-environment')?.pid).toBe(h.children[1].pid);
  });

  it('a late old process exit cannot stop a replacement proxy or change its UI status', async () => {
    const status = vi.fn();
    await launchEnv(environment(), 'chrome-test.exe', undefined, status); devToolsReady();
    await vi.waitFor(() => expect(h.connect).toHaveBeenCalledTimes(1));
    closeEnv('owned-environment');
    await launchEnv(environment(), 'chrome-test.exe', undefined, status); devToolsReady();
    await vi.waitFor(() => expect(h.connect).toHaveBeenCalledTimes(2));
    const stops = h.stopProxy.mock.calls.length;
    status.mockClear(); h.children[0].emit('exit', 0);
    expect(h.stopProxy).toHaveBeenCalledTimes(stops);
    expect(status).not.toHaveBeenCalled();
    expect(getRuntime('owned-environment')?.pid).toBe(h.children[1].pid);
  });
});
