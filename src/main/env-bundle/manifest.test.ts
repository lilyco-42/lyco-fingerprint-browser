import { describe, it, expect } from 'vitest';
import { validateManifest, BUNDLE_FORMAT, BUNDLE_VERSION, MAX_BUNDLE_ITEMS, profilePrefix, profileDataPath } from './manifest';
import { makeEnv, makeSource, makeNode } from './fixtures.test-helper';

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, appVersion: '0.0.2',
    exportedAt: '2026-09-26T00:00:00.000Z', includesProfile: false,
    items: [{ env: makeEnv() }],
    ...over,
  };
}

describe('validateManifest', () => {
  it('接受合法清单并原样还原环境字段', () => {
    const m = validateManifest(manifest());
    expect(m.items).toHaveLength(1);
    expect(m.items[0].env).toEqual(makeEnv());
    expect(m.items[0].proxy).toBeUndefined();
    expect(m.items[0].hasProfile).toBe(false);
  });

  it('读取 hasProfile 标记', () => {
    const m = validateManifest(manifest({ items: [{ env: makeEnv(), hasProfile: true }] }));
    expect(m.items[0].hasProfile).toBe(true);
  });

  it('解析代理源与节点，并以节点数量为准重算 nodeCount', () => {
    const m = validateManifest(manifest({
      items: [{ env: makeEnv(), proxy: { source: makeSource({ nodeCount: 99 }), nodes: [makeNode()] } }],
    }));
    expect(m.items[0].proxy?.source.nodeCount).toBe(1);
    expect(m.items[0].proxy?.nodes[0]).toEqual(makeNode());
  });

  it('丢弃未知字段', () => {
    const env = { ...makeEnv(), evil: '<script>' };
    const m = validateManifest(manifest({ items: [{ env, extra: 1 }], junk: true }));
    expect(m.items[0].env).not.toHaveProperty('evil');
    expect(m).not.toHaveProperty('junk');
  });

  it('兼容旧版本缺失的指纹字段与可选环境字段', () => {
    const { gpuVendor, gpuRenderer, ...fp } = makeEnv().fingerprint;
    void gpuVendor; void gpuRenderer;
    const env = { id: 'old', name: '旧环境', fingerprint: fp };
    const m = validateManifest(manifest({ items: [{ env }] }));
    expect(m.items[0].env.fingerprint).not.toHaveProperty('gpuVendor');
    expect(m.items[0].env.proxyMode).toBe('');
    expect(m.items[0].env.notes).toBe('');
  });

  it.each([
    ['非对象', null],
    ['数组', []],
    ['错误的 format', manifest({ format: 'other' })],
    ['更高的版本', manifest({ version: BUNDLE_VERSION + 1 })],
    ['includesProfile 非布尔', manifest({ includesProfile: 'yes' })],
    ['空 items', manifest({ items: [] })],
    ['items 非数组', manifest({ items: {} })],
    ['超出数量上限', manifest({ items: Array.from({ length: MAX_BUNDLE_ITEMS + 1 }, (_, i) => ({ env: makeEnv({ id: `e${i}` }) })) })],
    ['重复 ID', manifest({ items: [{ env: makeEnv() }, { env: makeEnv() }] })],
    ['ID 含路径字符', manifest({ items: [{ env: makeEnv({ id: '../x' }) }] })],
    ['name 非字符串', manifest({ items: [{ env: { ...makeEnv(), name: 1 } }] })],
    ['name 过长', manifest({ items: [{ env: makeEnv({ name: 'x'.repeat(300) }) }] })],
    ['非法 proxyMode', manifest({ items: [{ env: { ...makeEnv(), proxyMode: 'vpn' } }] })],
    ['指纹数字为 NaN', manifest({ items: [{ env: { ...makeEnv(), fingerprint: { screenWidth: NaN } } }] })],
    ['指纹字符串类型错误', manifest({ items: [{ env: { ...makeEnv(), fingerprint: { timezone: 8 } } }] })],
    ['batteryCharging 非布尔', manifest({ items: [{ env: { ...makeEnv(), fingerprint: { batteryCharging: 1 } } }] })],
    ['缺少 fingerprint', manifest({ items: [{ env: { ...makeEnv(), fingerprint: undefined } }] })],
    ['非法源类型', manifest({ items: [{ env: makeEnv(), proxy: { source: makeSource({ type: 'x' as never }), nodes: [] } }] })],
    ['hasProfile 非布尔', manifest({ items: [{ env: makeEnv(), hasProfile: 'y' }] })],
    ['nodes 非数组', manifest({ items: [{ env: makeEnv(), proxy: { source: makeSource(), nodes: 'a' } }] })],
    ['节点缺少 rawYaml', manifest({ items: [{ env: makeEnv(), proxy: { source: makeSource(), nodes: [{ ...makeNode(), rawYaml: undefined }] } }] })],
  ])('拒绝：%s', (_label, raw) => {
    expect(() => validateManifest(raw)).toThrow(/导入文件格式无效/);
  });

  it('proxy 为 null 时视为无代理', () => {
    const m = validateManifest(manifest({ items: [{ env: makeEnv(), proxy: null }] }));
    expect(m.items[0].proxy).toBeUndefined();
  });
});

describe('profilePrefix', () => {
  it('生成包内 Profile 目录前缀', () => {
    expect(profilePrefix('abc')).toBe('profiles/abc/');
    expect(profileDataPath('abc')).toBe('profiles/abc/chrome_data');
  });
});
