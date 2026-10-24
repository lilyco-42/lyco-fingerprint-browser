import WebSocket from 'ws';
import http from 'node:http';
import type { FingerprintConfig } from '../types';
import { buildFingerprintScript, getPlatformVersionForUserAgentData } from './fingerprint';
import { ProxyFailureWatcher, type WatcherHooks } from './proxy-guard/failure-watcher';

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
  url?: string;
}

interface PendingCmd {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface NavigationGate {
  phase: 'configuring' | 'ready' | 'failed';
  resumed: boolean;
  language: string;
  requests: Map<string, Record<string, string>>;
}

export class CdpClient {
  private ws: WebSocket | null = null;
  private cmdId = 0;
  private pending = new Map<number, PendingCmd>();
  private pageSessions: string[] = [];
  private fingerprintedSessions = new Set<string>();
  private initializingSessions = new Map<string, Promise<void>>();
  private targetSessions = new Map<string, string>();
  private navigationGates = new Map<string, NavigationGate>();
  private closed = false;
  private initialized = false;
  private initializationError: Error | null = null;
  private failureWatcher: ProxyFailureWatcher | null;

  constructor(
    private debugPort: number,
    private fingerprint: FingerprintConfig,
    private userAgent: string,
    failureHooks?: WatcherHooks,
    private onFatalError?: (error: Error) => void,
  ) {
    this.failureWatcher = failureHooks
      ? new ProxyFailureWatcher((method, params, sessionId) => this.send(method, params, sessionId), failureHooks)
      : null;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('Client closed');
    const url = await this.getWebSocketUrl();
    if (this.closed) throw new Error('Client closed');
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', async () => {
        try {
          await this.startSession();
          if (this.initializationError) throw this.initializationError;
          if (this.closed) throw new Error('Client closed');
          this.initialized = true;
          resolve();
        } catch (e) {
          reject(e);
          this.fail(e);
        }
      });
      this.ws.on('message', (data) => {
        try {
          this.handleMessage(JSON.parse(data.toString()) as CdpMessage);
        } catch { /* ignore parse errors */ }
      });
      this.ws.on('error', (error) => { reject(error); this.fail(error); });
      this.ws.on('close', () => {
        const error = this.initializationError ?? new Error('WebSocket closed');
        reject(error);
        this.fail(error);
      });
    });
  }

  private getWebSocketUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${this.debugPort}/json/version`, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const info = JSON.parse(data) as { webSocketDebuggerUrl: string };
            resolve(info.webSocketDebuggerUrl);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => { req.destroy(); reject(new Error('DevTools HTTP timeout')); });
    });
  }

  private async startSession(): Promise<void> {
    // Enable Target auto-attach to intercept new pages
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    // Attach to existing pages and apply fingerprint immediately.
    await this.attachExistingPageTargets();
    if (!this.pageSessions.length) throw new Error('No configured page session available');
  }

  private async attachExistingPageTargets(): Promise<void> {
    const result = await this.send('Target.getTargets', {}) as { targetInfos?: CdpTargetInfo[] };
    const targets = result.targetInfos ?? [];
    for (const target of targets) {
      if (target.type !== 'page') continue;
      let sessionId = this.targetSessions.get(target.targetId);
      if (!sessionId) {
        const attached = await this.send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        }) as { sessionId?: string };
        sessionId = attached.sessionId;
      }
      if (!sessionId) throw new Error('Page attachment did not return a session');
      this.targetSessions.set(target.targetId, sessionId);
      this.failureWatcher?.attach(sessionId, target.targetId);
      await this.applyFingerprint(sessionId);
      if (target.url && target.url !== 'about:blank' && !target.url.startsWith('chrome://') && !target.url.startsWith('devtools://')) {
        await this.send('Page.reload', { ignoreCache: true }, sessionId);
      }
    }
  }

  private handleMessage(msg: CdpMessage): void {
    if (this.closed) return;
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method === 'Fetch.requestPaused' && msg.sessionId) {
      const gate = this.navigationGates.get(msg.sessionId);
      if (!gate) return;
      const { requestId, request } = msg.params as { requestId: string; request: { headers: Record<string, string> } };
      gate.requests.set(requestId, request.headers);
      if (gate.phase === 'ready') {
        this.continueNavigation(msg.sessionId, gate, requestId).catch(error => {
          this.abortNavigation(msg.sessionId!).finally(() => this.fail(error));
        });
      } else if (gate.phase === 'failed') {
        this.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, msg.sessionId).catch(() => { /* target is closing */ });
      }
    } else if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo, waitingForDebugger } = msg.params as {
        sessionId: string; targetInfo: { type: string; targetId: string }; waitingForDebugger?: boolean;
      };
      if (targetInfo?.type === 'page') {
        this.targetSessions.set(targetInfo.targetId, sessionId);
        this.failureWatcher?.attach(sessionId, targetInfo.targetId);
        // A rejected page configuration must not resume an unconfigured page.
        this.applyFingerprint(sessionId, waitingForDebugger === true).catch(error => {
          if (this.targetSessions.get(targetInfo.targetId) === sessionId) this.fail(error);
        });
      } else {
        // Preserve the existing optional setup of non-page targets. They do
        // not establish page readiness or satisfy this required-page contract.
        this.configurePage(sessionId, false).catch(() => { /* target may already be gone */ });
      }
    } else if (msg.method === 'Target.detachedFromTarget') {
      const { sessionId } = msg.params as { sessionId: string };
      this.pageSessions = this.pageSessions.filter(s => s !== sessionId);
      this.fingerprintedSessions.delete(sessionId);
      this.navigationGates.delete(sessionId);
      for (const [targetId, attached] of this.targetSessions) {
        if (attached === sessionId) this.targetSessions.delete(targetId);
      }
      this.failureWatcher?.detach(sessionId);
    } else if (msg.method) {
      this.failureWatcher?.handleEvent(msg.method, (msg.params ?? {}) as Record<string, unknown>, msg.sessionId);
    }
  }

  private send(method: string, params: unknown = {}, sessionId?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }
      const id = ++this.cmdId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      const msg: CdpMessage = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(msg)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private applyFingerprint(sessionId: string, waitingForDebugger = false): Promise<void> {
    if (this.fingerprintedSessions.has(sessionId)) return Promise.resolve();
    const pending = this.initializingSessions.get(sessionId);
    if (pending) return pending;
    const setup = this.configurePage(sessionId, true, waitingForDebugger)
      .catch(async error => { await this.abortNavigation(sessionId); throw error; })
      .finally(() => this.initializingSessions.delete(sessionId));
    this.initializingSessions.set(sessionId, setup);
    return setup;
  }

  private async configurePage(sessionId: string, required = true, waitingForDebugger = false): Promise<void> {

    if (required && waitingForDebugger) {
      // Runtime.enable itself can wait for renderer startup. Hold document
      // requests in the browser process before allowing that startup; required
      // configuration still has to succeed before a request is continued.
      const gate: NavigationGate = { phase: 'configuring', resumed: false,
        language: this.fingerprint.language, requests: new Map() };
      this.navigationGates.set(sessionId, gate);
      await this.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, sessionId);
      gate.resumed = true;
      await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    }

    const fp = this.fingerprint;
    const send = (method: string, params: unknown) => {
      const command = this.send(method, params, sessionId);
      return required ? command : command.catch(() => { /* legacy non-page best effort */ });
    };
    const scriptSource = buildFingerprintScript(fp, this.userAgent);

    // Map navigator.platform → userAgentData.platform
    const uaDataPlatform = fp.platform === 'Win32'    ? 'Windows'
      : fp.platform === 'MacIntel'                    ? 'macOS'
      : fp.platform === 'iPhone'                      ? 'iOS'
      : fp.platform?.startsWith('Linux')              ? 'Linux'
      : 'Windows';
    const uaDataPlatformVersion = getPlatformVersionForUserAgentData(fp.platform);
    const isMobile = fp.maxTouchPoints > 0;

    await send('Runtime.enable', {});
    await send('Page.enable', {});
    await send('Network.enable', {});
    await send('Emulation.setUserAgentOverride', {
      userAgent: this.userAgent,
      acceptLanguage: fp.language,
      platform: fp.platform ?? 'Win32',
      userAgentMetadata: {
        platform:        uaDataPlatform,
        platformVersion: uaDataPlatformVersion,
        architecture:    fp.architecture ?? 'x86',
        model:           '',
        mobile:          isMobile,
        bitness:         '64',
        wow64:           false,
      },
    });
    // 通过 CDP 在浏览器层覆盖 screen.width / screen.height / devicePixelRatio
    // dontSetVisibleSize:true 保证不改变 Electron 窗口实际尺寸
    await send('Emulation.setDeviceMetricsOverride', {
      width:             fp.screenWidth,
      height:            fp.screenHeight,
      deviceScaleFactor: fp.devicePixelRatio ?? 1,
      mobile:            isMobile,
      screenWidth:       fp.screenWidth,
      screenHeight:      fp.screenHeight,
      dontSetVisibleSize: true,
    });
    await send('Emulation.setTimezoneOverride', { timezoneId: fp.timezone });
    await send('Emulation.setGeolocationOverride', {
      latitude: fp.latitude,
      longitude: fp.longitude,
      accuracy: 10,
    });
    await send('Network.setExtraHTTPHeaders', {
      headers: { 'Accept-Language': fp.language },
    });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: scriptSource,
    });
    // A new page paused before its first document has no runnable main context
    // yet. Its new-document script is registered above; evaluating now can wait
    // for the very startup that runIfWaitingForDebugger must release below.
    // Existing running documents still require an acknowledged evaluation.
    if (!waitingForDebugger) {
      const evaluated = await send('Runtime.evaluate', {
        expression: scriptSource,
        returnByValue: true,
        awaitPromise: false,
      }) as { exceptionDetails?: unknown } | undefined;
      if (required && evaluated?.exceptionDetails) throw new Error('Page configuration script failed');
    }

    if (required && ![...this.targetSessions.values()].includes(sessionId)) throw new Error('Page detached during configuration');
    if (!waitingForDebugger) await send('Runtime.runIfWaitingForDebugger', {});
    if (!required) return;
    if (this.closed) throw new Error('Client closed');
    const gate = this.navigationGates.get(sessionId);
    if (gate) {
      gate.phase = 'ready';
      for (const requestId of [...gate.requests.keys()]) await this.continueNavigation(sessionId, gate, requestId);
    }
    if (this.closed || ![...this.targetSessions.values()].includes(sessionId)) throw new Error('Page detached during configuration');
    // Register readiness only after every required command has succeeded.
    this.fingerprintedSessions.add(sessionId);
    if (!this.pageSessions.includes(sessionId)) this.pageSessions.push(sessionId);
  }

  private async continueNavigation(sessionId: string, gate: NavigationGate, requestId: string): Promise<void> {
    const original = gate.requests.get(requestId);
    if (!original || gate.phase !== 'ready') return;
    gate.requests.delete(requestId);
    // Preserve all other headers in memory; never log cookies or credentials.
    // A request paused before configuration can still carry its earlier UA.
    const headers = Object.entries(original)
      .filter(([name]) => !['user-agent', 'accept-language'].includes(name.toLowerCase()))
      .map(([name, value]) => ({ name, value }));
    headers.push({ name: 'User-Agent', value: this.userAgent }, { name: 'Accept-Language', value: gate.language });
    await this.send('Fetch.continueRequest', { requestId, headers }, sessionId);
  }

  private async abortNavigation(sessionId: string): Promise<void> {
    const gate = this.navigationGates.get(sessionId);
    if (!gate) return;
    gate.phase = 'failed';
    for (const requestId of [...gate.requests.keys()]) {
      gate.requests.delete(requestId);
      await this.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, sessionId).catch(() => { /* target may have closed */ });
    }
    if (gate.resumed) await this.send('Page.stopLoading', {}, sessionId).catch(() => { /* owner closes the browser on failure */ });
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const failure = error instanceof Error ? error : new Error('Page configuration failed');
    this.initializationError = failure;
    // Let an owner signal its browser to stop before detaching the transport.
    try { this.onFatalError?.(failure); } finally { this.close(); }
  }

  async navigate(url: string): Promise<void> {
    const sessionId = this.pageSessions[this.pageSessions.length - 1];
    if (!this.initialized || this.closed || !sessionId) throw new Error('No configured page session available');
    const result = await this.send('Page.navigate', { url }, sessionId) as { errorText?: string } | undefined;
    if (result?.errorText) throw new Error('Initial page navigation failed');
  }

  async runScript(expression: string): Promise<{ result: unknown; exceptionMessage?: string }> {
    const sessionId = this.pageSessions[this.pageSessions.length - 1];
    if (!sessionId) {
      throw new Error('没有可用的页面会话，请确认 Chrome 已打开页面');
    }
    const raw = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, sessionId) as {
      result: { type: string; value?: unknown; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };

    if (raw.exceptionDetails) {
      const msg = raw.exceptionDetails.exception?.description
        ?? raw.exceptionDetails.text
        ?? 'Script threw an exception';
      throw new Error(msg);
    }

    return { result: raw.result.value ?? raw.result.description ?? null };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.forEach(p => {
      clearTimeout(p.timer);
      p.reject(new Error('Client closed'));
    });
    this.pending.clear();
    for (const sessionId of new Set([...this.pageSessions, ...this.targetSessions.values()])) this.failureWatcher?.detach(sessionId);
    this.pageSessions = [];
    this.fingerprintedSessions.clear();
    this.targetSessions.clear();
    this.navigationGates.clear();
    this.ws?.close();
    this.ws = null;
  }
}
