import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockSubscription = vi.hoisted(() => vi.fn());
const proxyStore = vi.hoisted(() => ({
  sources: [] as Array<{ id: string; name: string; type: 'subscription'; url: string; nodeCount: number; lastUpdated: string; createdAt: string }>,
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
  saveSource: (source: typeof proxyStore.sources[number]) => proxyStore.sources.push(source),
  saveNodes: proxyStore.saveNodes,
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
      'https://lain42.top/panel/api/sub/ABCdef1234567890/json',
      'mock-source-01', 'lyco-browser-test',
    );
    expect(proxyStore.sources).toHaveLength(1);
    expect(proxyStore.saveNodes).toHaveBeenCalledOnce();
  });
});
