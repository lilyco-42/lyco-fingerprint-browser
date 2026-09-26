import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { planProxyImports, applyProxyResult, buildProxiesYaml } from './proxy-remap';
import { makeEnv, makeSource, makeNode, seqId } from './fixtures.test-helper';
import type { BundleItem } from './manifest';

const NOW = '2026-09-26T00:00:00.000Z';

function mihomoItem(envId: string, over: { url?: string; type?: 'subscription' | 'file'; srcId?: string } = {}): BundleItem {
  const srcId = over.srcId ?? 'src-1';
  return {
    env: makeEnv({ id: envId, proxyMode: 'mihomo', proxySourceId: srcId, proxyNodeId: 'node-2' }),
    proxy: {
      source: makeSource({ id: srcId, url: over.url ?? 'https://sub.example.com/a', type: over.type ?? 'subscription' }),
      nodes: [makeNode({ sourceId: srcId }), makeNode({ id: 'node-2', sourceId: srcId, name: 'JP-01' })],
    },
    hasProfile: false,
  };
}

describe('planProxyImports', () => {
  it('无代理与简单代理不产生新源', () => {
    const plan = planProxyImports(
      [{ env: makeEnv(), hasProfile: false }, { env: makeEnv({ id: 'e2', proxyMode: 'simple', proxySimple: 'socks5://a:1' }), hasProfile: false }],
      [], [], seqId(), NOW,
    );
    expect(plan.results.map(r => r.action)).toEqual(['none', 'simple']);
    expect(plan.newSources).toHaveLength(0);
    expect(plan.results[1]).toMatchObject({ proxySourceId: '', proxyNodeId: '' });
  });

  it('本机存在同 URL 订阅且有同名节点时复用', () => {
    const local = makeSource({ id: 'local-src', name: '本机机场' });
    const localNode = makeNode({ id: 'local-node', sourceId: 'local-src', name: 'JP-01' });
    const plan = planProxyImports([mihomoItem('e1')], [local], [localNode], seqId(), NOW);
    expect(plan.results[0]).toEqual({
      action: 'reuse', sourceName: '本机机场', nodeName: 'JP-01', proxySourceId: 'local-src', proxyNodeId: 'local-node',
    });
    expect(plan.newSources).toHaveLength(0);
  });

  it('同 URL 但无同名节点时新建源', () => {
    const local = makeSource({ id: 'local-src' });
    const plan = planProxyImports([mihomoItem('e1')], [local], [], seqId(), NOW);
    expect(plan.results[0].action).toBe('create');
  });

  it('新建源时重新分配源与节点 ID，并指向对应节点', () => {
    const plan = planProxyImports([mihomoItem('e1')], [], [], seqId(), NOW);
    const [created] = plan.newSources;
    expect(created.source).toMatchObject({ id: 'new-1', name: '机场 (导入)', nodeCount: 2, lastUpdated: NOW });
    expect(created.nodes.map(n => [n.id, n.sourceId, n.name])).toEqual([
      ['new-2', 'new-1', 'HK-01'], ['new-3', 'new-1', 'JP-01'],
    ]);
    expect(plan.results[0]).toMatchObject({ action: 'create', proxySourceId: 'new-1', proxyNodeId: 'new-3', nodeName: 'JP-01' });
  });

  it('同一次导入中共享的源只创建一次', () => {
    const plan = planProxyImports([mihomoItem('e1'), mihomoItem('e2')], [], [], seqId(), NOW);
    expect(plan.newSources).toHaveLength(1);
    expect(plan.results[0].proxyNodeId).toBe(plan.results[1].proxyNodeId);
  });

  it('文件型源导入后清空本机无意义的路径，且不同包内 ID 分别创建', () => {
    const plan = planProxyImports(
      [mihomoItem('e1', { type: 'file', url: '/Users/x/a.yaml' }), mihomoItem('e2', { type: 'file', srcId: 'src-2' })],
      [makeSource({ type: 'file', url: '/Users/x/a.yaml' })], [], seqId(), NOW,
    );
    expect(plan.newSources).toHaveLength(2);
    expect(plan.newSources[0].source.url).toBe('');
  });

  it('包内缺少代理数据或引用节点时标记为 missing', () => {
    const noProxy: BundleItem = { env: makeEnv({ proxyMode: 'mihomo', proxyNodeId: 'x' }), hasProfile: false };
    const badRef = mihomoItem('e2');
    const badRefItem: BundleItem = { ...badRef, env: { ...badRef.env, proxyNodeId: 'gone' } };
    const plan = planProxyImports([noProxy, badRefItem], [], [], seqId(), NOW);
    expect(plan.results.map(r => r.action)).toEqual(['missing', 'missing']);
    expect(plan.results[1]).toMatchObject({ sourceName: '机场', proxySourceId: '', proxyNodeId: '' });
  });
});

describe('planProxyImports 用户指定线路', () => {
  const local = makeSource({ id: 'local-src', name: '本机源', url: 'https://other.example.com' });
  const localNode = makeNode({ id: 'local-node', sourceId: 'local-src', name: 'US-01' });

  it('选择无代理时不新建代理源', () => {
    const plan = planProxyImports([mihomoItem('e1')], [], [], seqId(), NOW, [{ kind: 'none' }]);
    expect(plan.results[0].action).toBe('none');
    expect(plan.newSources).toHaveLength(0);
  });

  it('选择本机节点时直接引用，不新建代理源', () => {
    const simpleItem: BundleItem = { env: makeEnv({ id: 'e2', proxyMode: 'simple', proxySimple: 'socks5://a:1' }), hasProfile: false };
    const plan = planProxyImports([mihomoItem('e1'), simpleItem], [local], [localNode], seqId(), NOW,
      [{ kind: 'node', nodeId: 'local-node' }, { kind: 'node', nodeId: 'local-node' }]);
    expect(plan.results.map(r => r.action)).toEqual(['reuse', 'reuse']);
    expect(plan.results[1]).toMatchObject({ sourceName: '本机源', nodeName: 'US-01', proxySourceId: 'local-src', proxyNodeId: 'local-node' });
    expect(plan.newSources).toHaveLength(0);
  });

  it('只有保持原配置的环境才会新建代理源', () => {
    const plan = planProxyImports([mihomoItem('e1'), mihomoItem('e2')], [local], [localNode], seqId(), NOW,
      [{ kind: 'node', nodeId: 'local-node' }, { kind: 'keep' }]);
    expect(plan.results.map(r => r.action)).toEqual(['reuse', 'create']);
    expect(plan.newSources).toHaveLength(1);
  });

  it('所选节点在本机不存在时报错', () => {
    expect(() => planProxyImports([mihomoItem('e1')], [local], [localNode], seqId(), NOW, [{ kind: 'node', nodeId: 'gone' }]))
      .toThrow(/所选线路不存在/);
  });
});

describe('applyProxyResult', () => {
  it('none 清空全部代理配置', () => {
    const env = makeEnv({ proxyMode: 'simple', proxySimple: 'socks5://a:1' });
    expect(applyProxyResult(env, { action: 'none', sourceName: '', nodeName: '', proxySourceId: '', proxyNodeId: '' }))
      .toMatchObject({ proxyMode: '', proxySimple: '', proxySourceId: '', proxyNodeId: '' });
  });

  it('reuse 切换为 Mihomo 线路并清空简单代理', () => {
    const env = makeEnv({ proxyMode: 'simple', proxySimple: 'socks5://a:1' });
    expect(applyProxyResult(env, { action: 'reuse', sourceName: '', nodeName: '', proxySourceId: 's', proxyNodeId: 'n' }))
      .toMatchObject({ proxyMode: 'mihomo', proxySimple: '', proxySourceId: 's', proxyNodeId: 'n' });
  });

  it('simple 保留简单代理地址', () => {
    const env = makeEnv({ proxyMode: 'simple', proxySimple: 'socks5://a:1' });
    expect(applyProxyResult(env, { action: 'simple', sourceName: '', nodeName: '', proxySourceId: '', proxyNodeId: '' }))
      .toMatchObject({ proxyMode: 'simple', proxySimple: 'socks5://a:1' });
  });


  it('返回新对象且不修改原环境', () => {
    const env = makeEnv({ proxySourceId: 'a', proxyNodeId: 'b' });
    const out = applyProxyResult(env, { action: 'create', sourceName: '', nodeName: '', proxySourceId: 'x', proxyNodeId: 'y' });
    expect(out).not.toBe(env);
    expect(out).toMatchObject({ proxySourceId: 'x', proxyNodeId: 'y' });
    expect(env.proxySourceId).toBe('a');
  });
});

describe('buildProxiesYaml', () => {
  it('兼容数组与对象形式的 rawYaml，跳过损坏或无名节点', () => {
    const out = buildProxiesYaml([
      makeNode(),
      makeNode({ rawYaml: 'name: JP-01\ntype: vmess\nserver: 2.2.2.2\nport: 1' }),
      makeNode({ rawYaml: 'type: ss' }),
      makeNode({ rawYaml: ': : :\n  - [' }),
    ]);
    const parsed = yaml.load(out) as { proxies: Array<{ name: string }> };
    expect(parsed.proxies.map(p => p.name)).toEqual(['HK-01', 'JP-01']);
  });
});
