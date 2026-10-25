'use strict';
// This executes the built application only in a disposable Windows Actions VM.
// It reads the owned renderer and local environment list; no login or purchases.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') {
  throw new Error('Disposable Windows GitHub Actions only');
}
const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'lyco-browser.exe') {
  throw new Error('Expected the owned portable package executable');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { source: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID,
  productAcceptance: false, packagedRenderer: false, localIpc: false, executableSha256: '' };

function readRenderer(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      reject(new Error('Renderer endpoint must be loopback')); return;
    }
    const socket = new WebSocket(url);
    const timer = setTimeout(() => finish(new Error('Renderer read timed out')), 5000);
    let finished = false;
    function finish(error, value) {
      if (finished) return; finished = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(value);
    }
    socket.addEventListener('error', () => finish(new Error('Renderer connection failed')));
    socket.addEventListener('close', () => finish(new Error('Renderer connection closed')));
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async () => ({ ready: document.readyState,
        hasControls: !!document.querySelector('#btn-create-env') && !!document.querySelector('#panel-lyco'),
        ipc: typeof window.api?.envList === 'function' && Array.isArray(await window.api.envList()) }))()`,
      returnByValue: true, awaitPromise: true,
    } })));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error || message.result?.exceptionDetails) finish(new Error('Packaged renderer evaluation failed'));
        else finish(null, message.result?.result?.value);
      } catch { finish(new Error('Invalid renderer response')); }
    });
  });
}

(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lyco-preview-owned-'));
  let child;
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(executable)) hash.update(chunk);
    report.executableSha256 = hash.digest('hex');
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const env = { ...process.env };
    for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[key];
    child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1', '--disable-gpu', '--no-first-run'],
    { windowsHide: true, stdio: 'ignore', env });
    let spawnFailed = false; child.once('error', () => { spawnFailed = true; });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnFailed || child.exitCode !== null) throw new Error('Owned package exited before renderer readiness');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        const targets = await response.json();
        const pages = targets.filter(target => target.type === 'page' && target.url.startsWith('file:') && target.url.includes('index.html'));
        if (pages.length === 1) {
          const value = await readRenderer(pages[0].webSocketDebuggerUrl);
          if (value?.ready === 'complete' && value.hasControls && value.ipc) {
            report.packagedRenderer = true; report.localIpc = true; return;
          }
        }
      } catch { /* owned renderer is still starting */ }
      await sleep(300);
    }
    throw new Error('Packaged renderer and local IPC did not become ready');
  } finally {
    if (child?.pid && child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) await sleep(50);
      if (child.exitCode === null) throw new Error('Owned preview process did not stop');
    }
    await fs.writeFile('windows-preview-smoke.json', JSON.stringify(report, null, 2));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    console.log(JSON.stringify(report));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
