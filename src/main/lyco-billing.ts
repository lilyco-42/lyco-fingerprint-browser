/**
 * LYCO Billing adapter for the existing lain42.top studio-billing service.
 * UI never receives the password, Bearer token or proxy subscription secret.
 * Payment creation is only available after an explicit click + confirmation.
 */
import { app, safeStorage, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as store from './store';
import { fetchSubscription } from './subscription';
import { preserveNodeIds } from './proxy-guard/node-ids';
import { generateFingerprint, generateUserAgent } from './fingerprint';
import { closeEnv } from './chrome-manager';

const API_BASE = 'https://lain42.top/studio/api';
const SHOP_URL = 'https://lain42.top/shop/#topup';
const PRODUCT = 'proxy_1m';
let liveToken: string | null = null;
let liveUsername: string | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let authGeneration = 0;

function closeOwnedEnvironments(): void {
  const owned = new Set(store.listSources().filter(s => s.lycoOwner).map(s => s.id));
  for (const env of store.listEnvs()) if (owned.has(env.proxySourceId)) closeEnv(env.id);
}

type Entitlement = {
  product: string; status: string; expires_at?: string | null;
  meta?: { sub_url?: string | null; [key: string]: unknown };
};
type BillingMe = {
  ok: boolean; username: string;
  points: { balance: number };
  entitlements: Entitlement[];
};
type BillingProduct = {
  code: string; name: string; points_price?: number; duration_days?: number;
};

function sessionPath(): string { return path.join(app.getPath('userData'), 'lyco-billing-session.json'); }
function pendingPath(): string { return path.join(app.getPath('userData'), 'lyco-billing-pending-purchase.json'); }
function writePrivate(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), { encoding: 'utf8', mode: 0o600 });
}

function restoreSession(): void {
  if (liveToken) return;
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const { encoded, username } = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'));
    if (typeof encoded !== 'string' || typeof username !== 'string') return;
    liveToken = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    liveUsername = username;
  } catch { /* no valid saved session */ }
}

async function request<T>(endpoint: string, opts: { method?: 'GET'|'POST'; token?: string; body?: unknown } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers: Record<string,string> = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(API_BASE + endpoint, {
      method: opts.method || 'GET', headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
      redirect: 'error',
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const detail = typeof payload.detail === 'string' ? payload.detail : '请求失败';
      throw new Error('Billing HTTP ' + response.status + '：' + detail);
    }
    return payload as T;
  } finally { clearTimeout(timeout); }
}

function token(): string {
  restoreSession();
  if (!liveToken) throw new Error('请先登录 LYCO 账号');
  return liveToken;
}
function entitlement(me: BillingMe): Entitlement | undefined {
  return me.entitlements.find(e =>
    e.product === PRODUCT && e.status === 'active'
    && (!e.expires_at || Date.parse(e.expires_at) > Date.now())
  );
}
function publicAccount(me: BillingMe) {
  return {
    username: me.username, pointsBalance: Number(me.points?.balance ?? 0),
    proxyActive: Boolean(entitlement(me)),
    proxyExpiresAt: entitlement(me)?.expires_at || null,
  };
}
async function rawMe(): Promise<BillingMe> {
  const session = token();
  const me = await request<BillingMe>('/me', { token: session });
  if (liveToken !== session) throw new Error('账号已变化，请重新操作');
  if (!me.ok || !Array.isArray(me.entitlements)) throw new Error('账户数据格式异常');
  clearTimeout(expiryTimer);
  const active = entitlement(me);
  if (!active) closeOwnedEnvironments();
  else if (active.expires_at) {
    const remaining = Date.parse(active.expires_at) - Date.now();
    expiryTimer = setTimeout(() => {
      if (liveToken !== session) return;
      if (remaining <= 2147483647) closeOwnedEnvironments();
      else void account().catch(() => closeOwnedEnvironments());
    }, Math.min(remaining, 2147483647));
    expiryTimer.unref?.();
  }
  return me;
}

export async function login(username: string, password: string) {
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password)
    throw new Error('请输入用户名和密码');
  logout();
  const generation = authGeneration;
  const result = await request<{ ok: boolean; token: string; username: string }>('/login', {
    method: 'POST', body: { username: username.trim(), password },
  });
  if (!result.ok || typeof result.token !== 'string') throw new Error('登录结果异常');
  if (generation !== authGeneration) throw new Error('登录已取消，请重新操作');
  liveToken = result.token;
  liveUsername = result.username;
  // Never save plaintext tokens. When OS-backed encryption is unavailable,
  // keep the token only in memory for this session.
  if (safeStorage.isEncryptionAvailable()) {
    const encoded = safeStorage.encryptString(result.token).toString('base64');
    writePrivate(sessionPath(), { username: result.username, encoded });
  }
  return publicAccount(await rawMe());
}
export function logout() {
  authGeneration++;
  closeOwnedEnvironments();
  clearTimeout(expiryTimer);
  liveToken = null; liveUsername = null;
  try { fs.rmSync(sessionPath(), { force: true }); } catch { /* no session */ }
  return { ok: true };
}
export async function account() {
  try { return publicAccount(await rawMe()); }
  catch (error) {
    if (error instanceof Error && /HTTP 401/.test(error.message)) logout();
    throw error;
  }
}
export async function plan() {
  const result = await request<{ products: BillingProduct[] }>('/products');
  const found = result.products?.find(p => p.code === PRODUCT);
  if (!found || !Number.isInteger(found.points_price) || (found.points_price || 0) <= 0)
    throw new Error('云端未提供有效的代理月卡价格');
  return { code: PRODUCT, name: found.name, pointsPrice: found.points_price,
    durationDays: found.duration_days || 30 };
}
export async function topup() { await shell.openExternal(SHOP_URL); return { ok: true }; }

function purchaseRef(username: string): string {
  try {
    const saved = JSON.parse(fs.readFileSync(pendingPath(), 'utf8'));
    if (saved.username === username && /^lyco-browser-[a-f0-9-]{36}$/.test(saved.reference))
      return saved.reference;
  } catch { /* no pending purchase */ }
  const reference = 'lyco-browser-' + randomUUID();
  writePrivate(pendingPath(), { username, reference });
  return reference;
}
/** The backend atomically redeems points and issues an entitlement. */
export async function purchaseProxy() {
  const me = await rawMe();
  if (entitlement(me)) throw new Error('代理月卡仍在有效期内，请勿重复购买');
  const product = await plan();
  if (me.points.balance < product.pointsPrice) throw new Error('积分不足，请先充值');
  const reference = purchaseRef(me.username);
  const paid = await request<{
    ok: boolean; order?: { order_no?: string }; points?: { balance: number }
  }>('/points/purchase', { method: 'POST', token: token(),
    body: { product: PRODUCT, reference } });
  if (!paid.ok) throw new Error('购买结果异常，请在账户订单中核实后重试');
  // Only remove the idempotency reference after a successful server response.
  try { fs.rmSync(pendingPath(), { force: true }); } catch { /* ignore */ }
  return { ok: true, orderNo: paid.order?.order_no || null, account: await account() };
}
function clashSubscriptionUrl(raw: string): string {
  // Only accept the exact token path of the existing proxy panel.
  const match = /^https:\/\/lain42\.top\/panel\/api\/sub\/([A-Za-z0-9_-]{12,256})\/?$/.exec(raw);
  if (!match) throw new Error('服务器下发的订阅格式不符合预期');
  return API_BASE + '/sub/' + match[1] + '/clash';
}
export async function importProxy() {
  const me = await rawMe();
  const active = entitlement(me);
  if (!active) throw new Error('没有有效代理月卡，请先购买或激活');
  const subUrl = active.meta?.sub_url;
  if (typeof subUrl !== 'string') throw new Error('月卡已激活但未分配订阅，请联系管理员');
  const url = clashSubscriptionUrl(subUrl);
  const exists = store.listSources().find(s => s.type === 'subscription' &&
    (s.lycoOwner === me.username || s.url === url || s.url === subUrl + '/json'));
  if (exists?.lycoOwner && exists.lycoOwner !== me.username) throw new Error('该代理源属于其他账号');
  const session = liveToken;
  const id = exists?.id || store.newId();
  const nodes = preserveNodeIds(exists ? store.listNodes(id) : [],
    await fetchSubscription(url, id, store.getConfig().subscriptionUserAgent));
  if (liveToken !== session) throw new Error('账号已变化，未导入代理');
  if (!nodes.length) throw new Error('订阅没有可用节点；不会添加空的代理源');
  store.saveSource({
    id, name: 'LYCO VPN · ' + me.username, type: 'subscription', url,
    nodeCount: nodes.length, lastUpdated: new Date().toISOString(),
    createdAt: exists?.createdAt || new Date().toISOString(), lycoOwner: me.username,
  });
  store.saveNodes(id, nodes);
  return { ok: true, imported: !exists, nodeCount: nodes.length, sourceId: id };
}

export async function authorizeSource(sourceId: string): Promise<void> {
  const source = store.listSources().find(s => s.id === sourceId);
  if (!source?.lycoOwner) return;
  const me = await rawMe();
  if (me.username !== source.lycoOwner) throw new Error('此环境使用其他账号的订阅，请切回原账号');
  if (!entitlement(me)) throw new Error('代理月卡已失效，请先续费');
}

export async function createOwnedEnvironment() {
  const imported = await importProxy();
  await authorizeSource(imported.sourceId);
  const source = store.listSources().find(s => s.id === imported.sourceId);
  const node = store.listNodes(imported.sourceId)[0];
  if (!source || !node) throw new Error('订阅没有可用节点');
  const env = store.saveEnv({id: store.newId(), name: 'LYCO 专属环境', createdAt: new Date().toISOString(),
    userAgent: generateUserAgent(), fingerprint: generateFingerprint(), proxyMode: 'mihomo',
    proxySimple: '', proxySourceId: source.id, proxyNodeId: node.id, notes: '本人网站订阅自动配置',
    homePage: 'https://lain42.top/account/'});
  return {id: env.id, name: env.name, nodeCount: imported.nodeCount};
}
