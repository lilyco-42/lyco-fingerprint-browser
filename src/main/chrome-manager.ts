import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { Environment, EnvRuntime } from '../types';
import { CdpClient } from './cdp-client';
import { startMihomoForEnv, stopMihomoForEnv, isMihomoRunning, probeEnvNode } from './mihomo-manager';
import { buildProxyArgs, parseSimpleProxy } from './proxy-guard/browser-proxy';
import { CORE_DOWN_ISSUE, diagnoseProxyFailure, shouldDiagnose, type ProxyFailureDiagnosis } from './proxy-guard/proxy-failure';
import { buildProxyErrorPage } from './proxy-guard/error-page';
import type { FailureInfo, WatcherHooks } from './proxy-guard/failure-watcher';

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

export function detectChrome(): string {
  const paths = CHROME_PATHS[process.platform] ?? [];
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

function getFreePort(start = 9222, end = 9999): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryPort = () => {
      if (port > end) { reject(new Error('No free port found')); return; }
      const server = net.createServer();
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
      server.on('error', () => { port++; tryPort(); });
    };
    tryPort();
  });
}

function waitForDevTools(port: number, maxMs = 10000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (Date.now() - start > maxMs) {
        reject(new Error(`DevTools not ready after ${maxMs}ms`));
        return;
      }
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { JSON.parse(data); resolve(); } catch { setTimeout(poll, 500); }
        });
      });
      req.on('error', () => setTimeout(poll, 500));
      req.setTimeout(1000, () => { req.destroy(); setTimeout(poll, 500); });
    };
    poll();
  });
}

/** 环境当前使用的代理线路，用于故障诊断、提示页展示与重启代理 */
type ProxyLine =
  | { mode: 'mihomo'; sourceId: string; nodeName: string; rawYaml: string; label: string }
  | { mode: 'simple'; label: string };

interface PreparedProxy {
  args: string[];
  socksPort?: number;
  line?: ProxyLine;
}

/**
 * 按环境的代理设置准备启动参数。任何异常（未选线路、节点失效、mihomo 启动失败、地址非法）都抛错，
 * 由调用方拒绝启动浏览器，绝不退化为直连。
 */
async function prepareProxy(env: Environment): Promise<PreparedProxy> {
  if (env.proxyMode === 'simple') {
    const args = buildProxyArgs({ kind: 'simple', raw: env.proxySimple });
    return { args, line: { mode: 'simple', label: parseSimpleProxy(env.proxySimple).server } };
  }
  if (env.proxyMode !== 'mihomo') return { args: [] };

  if (!env.proxyNodeId) throw new Error('该环境未选择代理线路，已阻止启动以免使用真实 IP');
  const { getNode, listSources } = await import('./store');
  const node = getNode(env.proxyNodeId);
  if (!node) {
    throw new Error('该环境的代理节点已不存在（订阅可能已被删除或更新），已阻止启动，请在“编辑”中重新选择线路');
  }
  const sourceName = listSources().find(s => s.id === node.sourceId)?.name ?? '未知订阅';
  const line: ProxyLine = {
    mode: 'mihomo', sourceId: node.sourceId, nodeName: node.name, rawYaml: node.rawYaml, label: `${sourceName} - ${node.name}`,
  };
  const socksPort = await startMihomoLine(env.id, line);
  return { args: buildProxyArgs({ kind: 'mihomo', socksPort }), socksPort, line };
}

function startMihomoLine(envId: string, line: Extract<ProxyLine, { mode: 'mihomo' }>, socksPort?: number): Promise<number> {
  return startMihomoForEnv(envId, line.sourceId, line.nodeName, line.rawYaml, {
    socksPort,
    onUnexpectedExit: () => setProxyIssue(envId, CORE_DOWN_ISSUE),
  });
}

interface RunningInstance {
  process: ChildProcess;
  cdpClient: CdpClient | null;
  connectingClient: CdpClient | null;
  runtime: EnvRuntime;
  line?: ProxyLine;
  onStatusChange?: StatusCallback;
}

const running = new Map<string, RunningInstance>();

export type StatusCallback = (envId: string, runtime: EnvRuntime) => void;

/** 更新环境的代理异常状态（undefined 表示恢复正常），有变化时通知界面 */
function setProxyIssue(envId: string, proxyIssue: string | undefined): void {
  const instance = running.get(envId);
  if (!instance || instance.runtime.proxyIssue === proxyIssue) return;
  instance.runtime = { ...instance.runtime, proxyIssue };
  instance.onStatusChange?.(envId, instance.runtime);
}

async function diagnoseEnvFailure(envId: string, line: ProxyLine, errorText: string): Promise<ProxyFailureDiagnosis | null> {
  if (line.mode === 'simple') return diagnoseProxyFailure({ mode: 'simple', errorText });
  const coreRunning = isMihomoRunning(envId);
  const nodeDelay = coreRunning ? await probeEnvNode(envId) : -1;
  return diagnoseProxyFailure({ mode: 'mihomo', errorText, nodeName: line.nodeName, coreRunning, nodeDelay });
}

/** 页面因代理故障加载失败时：诊断原因、标记代理异常，并生成本地提示页 */
function createFailureHooks(env: Environment, mode: ProxyLine['mode']): WatcherHooks {
  return {
    shouldHandle: errorText => shouldDiagnose(mode, errorText),
    renderFailure: async (info: FailureInfo) => {
      const line = running.get(env.id)?.line;
      if (!line) return null;
      const diagnosis = await diagnoseEnvFailure(env.id, line, info.errorText);
      if (!diagnosis) return null;
      if (diagnosis.issue) setProxyIssue(env.id, diagnosis.issue);
      return buildProxyErrorPage({ envName: env.name, lineLabel: line.label, url: info.url, errorText: info.errorText, diagnosis });
    },
    onRecovered: () => {
      // mihomo 已退出时不可能有经网络返回的文档，只清除其余异常
      if (running.get(env.id)?.runtime.proxyIssue !== CORE_DOWN_ISSUE) setProxyIssue(env.id, undefined);
    },
  };
}

export function getRuntime(envId: string): EnvRuntime | null {
  return running.get(envId)?.runtime ?? null;
}

export function getCdpClient(envId: string): CdpClient | null {
  return running.get(envId)?.cdpClient ?? null;
}

export function getAllRuntimes(): Record<string, EnvRuntime> {
  const result: Record<string, EnvRuntime> = {};
  for (const [id, info] of running.entries()) {
    result[id] = info.runtime;
  }
  return result;
}

export async function launchEnv(
  env: Environment,
  chromePath: string,
  homePage?: string,
  onStatusChange?: StatusCallback,
): Promise<EnvRuntime> {
  if (running.has(env.id)) {
    return running.get(env.id)!.runtime;
  }

  const proxy = await prepareProxy(env);
  const debugPort = await getFreePort().catch((e: Error) => {
    stopMihomoForEnv(env.id);
    throw e;
  });
  const userDataDir = path.join(app.getPath('userData'), 'profiles', env.id, 'chrome_data');
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...proxy.args,
  ];

  if (env.userAgent) {
    args.push(`--user-agent=${env.userAgent}`);
  }

  if (homePage) {
    args.push(homePage);
  }

  const chromeProcess = spawn(chromePath, args, { detached: false, stdio: 'ignore' });

  const runtime: EnvRuntime = {
    envId: env.id,
    running: true,
    pid: chromeProcess.pid,
    debugPort,
    proxyPort: proxy.socksPort,
    launchedAt: new Date().toISOString(),
  };

  const instance: RunningInstance = { process: chromeProcess, cdpClient: null, connectingClient: null, runtime, line: proxy.line, onStatusChange };
  running.set(env.id, instance);

  const onChromeGone = (): void => {
    instance.connectingClient?.close();
    instance.cdpClient?.close();
    // An old process may exit after this environment has already restarted.
    // It must not stop the replacement's proxy or overwrite its running status.
    if (running.get(env.id) !== instance) return;
    stopMihomoForEnv(env.id);
    running.delete(env.id);
    onStatusChange?.(env.id, { envId: env.id, running: false });
  };
  chromeProcess.once('exit', onChromeGone);
  chromeProcess.once('error', (e: Error) => {
    console.error(`[ChromeManager] Failed to spawn Chrome for ${env.name}:`, e.message);
    onChromeGone();
  });

  // Connect CDP asynchronously
  waitForDevTools(debugPort, 8000)
    .then(() => {
      if (running.get(env.id) !== instance) return;
      const client = new CdpClient(debugPort, env.fingerprint, env.userAgent, proxy.line ? createFailureHooks(env, proxy.line.mode) : undefined);
      // Retain the client during connection so cancellation/failure can close it.
      // Do not expose it through getCdpClient until it is actually connected.
      instance.connectingClient = client;
      return client.connect().then(() => {
        if (running.get(env.id) !== instance) { client.close(); return; }
        instance.connectingClient = null;
        instance.cdpClient = client;
      });
    })
    .catch((e: Error) => {
      console.error(`[ChromeManager] CDP connection failed for ${env.name}:`, e.message);
      if (running.get(env.id) === instance) closeEnv(env.id);
    });

  onStatusChange?.(env.id, runtime);
  return runtime;
}

/** 在浏览器已绑定的原端口上重新拉起 mihomo，浏览器无需关闭 */
export async function restartEnvProxy(envId: string): Promise<EnvRuntime> {
  const instance = running.get(envId);
  if (!instance) throw new Error('环境未在运行');
  const { line } = instance;
  const socksPort = instance.runtime.proxyPort;
  if (line?.mode !== 'mihomo' || !socksPort) throw new Error('该环境未使用订阅线路，无需重启代理');

  stopMihomoForEnv(envId);
  await startMihomoLine(envId, line, socksPort).catch((e: Error) => {
    setProxyIssue(envId, CORE_DOWN_ISSUE);
    throw e;
  });
  if (running.get(envId) !== instance) {
    // 重启期间浏览器已关闭，不再保留代理进程
    stopMihomoForEnv(envId);
    throw new Error('环境已关闭');
  }
  setProxyIssue(envId, undefined);
  return instance.runtime;
}

export function closeEnv(envId: string): void {
  stopMihomoForEnv(envId);
  const instance = running.get(envId);
  if (!instance) return;
  // Remove ownership before signalling the process; a late exit cannot affect
  // an environment relaunched under the same id.
  running.delete(envId);
  instance.connectingClient?.close();
  instance.cdpClient?.close();
  try { instance.process.kill(); } catch { /* already dead */ }
  instance.onStatusChange?.(envId, { envId, running: false });
}

const PROFILE_REMOVE_RETRIES = 5;
const PROFILE_REMOVE_RETRY_DELAY_MS = 300;

/** 删除环境的 Profile 目录（Chrome 数据与 mihomo 临时配置）；进程刚被结束时文件可能仍被占用，故带重试 */
export async function removeEnvProfile(envId: string): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'profiles', envId);
  try {
    await fs.promises.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: PROFILE_REMOVE_RETRIES,
      retryDelay: PROFILE_REMOVE_RETRY_DELAY_MS,
    });
  } catch (e) {
    console.error(`[ChromeManager] Failed to remove profile dir for env ${envId}:`, e);
  }
}

export function closeAll(): void {
  for (const id of running.keys()) {
    closeEnv(id);
  }
}
