import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockSubscription = vi.hoisted(() => vi.fn());
const closeEnv = vi.hoisted(() => vi.fn());
vi.mock('./chrome-manager', () => ({closeEnv}));
const proxyStore = vi.hoisted(() => ({
  sources: [] as Array<{ id: string; name: string; type: 'subscription'; url: string; nodeCount: number; lastUpdated: string; createdAt: string; lycoOwner?: string }>,
  envs: [] as import('../types').Environment[],
  nodes: new Map<string, import('../types').ProxyNode[]>(),
  saveNodes: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => process.env.RUNNER_TEMP || process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./store', () => ({
  getConfig: () => ({ subscriptionUserAgent: 'lyco-browser-test' }),
  listSources: () => proxyStore.sources,
  saveSource: (source: typeof proxyStore.sources[number]) => {const index=proxyStore.sources.findIndex(s=>s.id===source.id);if(index<0)proxyStore.sources.push(source);else proxyStore.sources[index]=source;},
  saveNodes: (id: string, nodes: import('../types').ProxyNode[]) => {proxyStore.saveNodes(id,nodes);proxyStore.nodes.set(id,nodes);},
  listNodes: (id: string) => proxyStore.nodes.get(id) || [],
  listEnvs: () => proxyStore.envs,
  saveEnv: (env: import('../types').Environment) => {proxyStore.envs.push(env);return env;},
  newId: () => 'mock-source-01',
}));
vi.mock('./subscription', () => ({ fetchSubscription: mockSubscription }));

import * as billing from './lyco-billing';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function mockFetch(dispatch: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string, init: RequestInit) => dispatch(url, init));
  vi.stubGlobal('fetch', mock);
  return mock;
}
const me = (proxyActive = false) => ({
  ok: true,
  username: 'qa-customer',
  points: { balance: 500 },
  entitlements: proxyActive
    ? [{ product: 'proxy_1m', status: 'active', expires_at: '2099-01-01T00:00:00Z',
         meta: { sub_url: 'https://lain42.top/panel/api/sub/ABCdef1234567890' } }]
    : [],
});
const product = { products: [{ code: 'proxy_1m', name: 'LYCO 代理月卡', points_price: 299, duration_days: 30 }] };

beforeEach(() => {
  billing.logout();
  proxyStore.sources.length = 0;
  proxyStore.envs.length = 0;proxyStore.nodes.clear();closeEnv.mockReset();
  proxyStore.saveNodes.mockReset();
  mockSubscription.mockReset();
  const base = process.env.RUNNER_TEMP || process.cwd();
  fs.rmSync(path.join(base, 'lyco-billing-pending-purchase.json'), { force: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('LYCO Billing adapter (no real network, no real charge)', () => {
  it('reads price only from authoritative product catalog', async () => {
    const mock = mockFetch((url) => {
      expect(url).toBe('https://lain42.top/studio/api/products');
      return json(product);
    });
    expect(await billing.plan()).toEqual({
      code: 'proxy_1m', name: 'LYCO 代理月卡', pointsPrice: 299, durationDays: 30,
    });
    expect(mock).toHaveBeenCalledOnce();
  });

  it('logs in and reads wallet and entitlement via the existing API', async () => {
    const mock = mockFetch((url, init) => {
      if (url.endsWith('/login')) {
        expect(init.method).toBe('POST');
        return json({ ok: true, token: 'TEST_TOKEN_ONLY', username: 'qa-customer' });
      }
      if (url.endsWith('/me')) {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TEST_TOKEN_ONLY');
        return json(me(true));
      }
      throw new Error('Unexpected network request: ' + url);
    });
    expect(await billing.login('qa-customer', 'mock-password')).toMatchObject({
      username: 'qa-customer', pointsBalance: 500, proxyActive: true,
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('reuses the same reference when a charge result is uncertain', async () => {
    const refs: string[] = [];
    let purchaseCalls = 0;
    mockFetch((url, init) => {
      if (url.endsWith('/login')) return json({ ok: true, token: 'QA_TOKEN', username: 'qa-customer' });
      if (url.endsWith('/me')) return json(me(false));
      if (url.endsWith('/products')) return json(product);
      if (url.endsWith('/points/purchase')) {
        purchaseCalls++;
        const payload = JSON.parse(String(init.body));
        refs.push(payload.reference);
        expect(payload.product).toBe('proxy_1m');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer QA_TOKEN');
        return purchaseCalls === 1 ? json({ detail: 'temporary server error' }, 503)
          : json({ ok: true, order: { order_no: 'QAORDER-1' } });
      }
      throw new Error('Unexpected network request: ' + url);
    });
    await billing.login('qa-customer', 'mock-password');
    await expect(billing.purchaseProxy()).rejects.toThrow('HTTP 503');
    expect((await billing.purchaseProxy()).orderNo).toBe('QAORDER-1');
    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(refs[1]);
    expect(refs[0]).toMatch(/^lyco-browser-[a-f0-9-]{36}$/);
  });

  it('rejects additional purchase when an unexpired proxy entitlement exists', async () => {
    const mock = mockFetch((url) => {
      if (url.endsWith('/login')) return json({ ok: true, token: 'QA_TOKEN', username: 'qa-customer' });
      if (url.endsWith('/me')) return json(me(true));
      throw new Error('Unexpected API request: ' + url);
    });
    await billing.login('qa-customer', 'mock-password');
    await expect(billing.purchaseProxy()).rejects.toThrow('仍在有效期');
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('imports only owned proxy subscription and never reveals the token to UI', async () => {
    mockFetch((url) => {
      if (url.endsWith('/login')) return json({ ok: true, token: 'QA_TOKEN', username: 'qa-customer' });
      if (url.endsWith('/me')) return json(me(true));
      throw new Error('Unexpected request: ' + url);
    });
    mockSubscription.mockResolvedValue([{ id: 'qa-node', name: 'proxy', server: 'example.test', port: 443 }]);
    await billing.login('qa-customer', 'mock-password');
    const result = await billing.importProxy();
    expect(result).toMatchObject({ ok: true, imported: true, nodeCount: 1 });
    expect(mockSubscription).toHaveBeenCalledWith(
      'https://lain42.top/studio/api/sub/ABCdef1234567890/clash',
      'mock-source-01', 'lyco-browser-test',
    );
    expect(proxyStore.sources).toHaveLength(1);
    expect(proxyStore.saveNodes).toHaveBeenCalledOnce();
  });

  it('creates an owned environment without launching and blocks another account or expired access', async () => {
    let current = me(true);
    mockFetch(url => url.endsWith('/login') ? json({ok:true,token:'CI_TOKEN',username:'qa-customer'}) : json(current));
    mockSubscription.mockResolvedValue([{id:'ci-node',name:'Node',sourceId:'mock-source-01',type:'http',server:'127.0.0.1',port:8000,rawYaml:'[]'}]);
    await billing.login('qa-customer','CI-password');
    const created=await billing.createOwnedEnvironment();
    expect(created.nodeCount).toBe(1);expect(proxyStore.envs[0].proxyMode).toBe('mihomo');
    expect(proxyStore.envs[0].proxyNodeId).toBe('ci-node');expect(closeEnv).not.toHaveBeenCalled();
    current={...me(true),username:'someone-else'};
    await expect(billing.authorizeSource('mock-source-01')).rejects.toThrow('其他账号');
    current=me(false);
    await expect(billing.authorizeSource('mock-source-01')).rejects.toThrow('失效');
    expect(closeEnv).toHaveBeenCalledWith(created.id);
  });

  it('refreshes the existing owned source while preserving selected node identifiers', async () => {
    mockFetch(url => url.endsWith('/login') ? json({ok:true,token:'CI_TOKEN',username:'qa-customer'}) : json(me(true)));
    mockSubscription.mockResolvedValue([{id:'old-node',name:'Same node',sourceId:'mock-source-01'}]);
    await billing.login('qa-customer','CI-password');await billing.importProxy();
    mockSubscription.mockResolvedValue([{id:'new-node',name:'Same node',sourceId:'mock-source-01'}]);
    const refreshed=await billing.importProxy();
    expect(refreshed.imported).toBe(false);expect(proxyStore.sources).toHaveLength(1);
    expect(proxyStore.nodes.get(refreshed.sourceId)?.[0].id).toBe('old-node');
  });
});
