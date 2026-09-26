// 导出 → 导入往返的集成测试（真实文件系统，临时目录模拟两台机器）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import type { Environment, ProxySource, ProxyNode } from '../../types';
import { exportBundle, collectProxy, type BundleDirs, type ExportDeps } from './exporter';
import { readBundleManifest } from './bundle-reader';
import { applyBundle, buildPreviewItems, maskProxyCredentials, type ImportDeps } from './importer';
import { BUNDLE_FORMAT, BUNDLE_VERSION } from './manifest';
import { makeEnv, makeSource, makeNode, seqId } from './fixtures.test-helper';
import { buildRawTarGz } from './raw-tar.test-helper';

interface FakeStore {
  envs: Environment[];
  sources: ProxySource[];
  nodes: ProxyNode[];
  backups: Record<string, string>;
}

function emptyStore(): FakeStore {
  return { envs: [], sources: [], nodes: [], backups: {} };
}

function exportDeps(s: FakeStore, running: string[] = []): ExportDeps {
  return {
    getEnv: id => s.envs.find(e => e.id === id) ?? null,
    listSources: () => s.sources,
    listNodes: () => s.nodes,
    isRunning: id => running.includes(id),
  };
}

function importDeps(s: FakeStore, genId = seqId('imp')): ImportDeps {
  return {
    listSources: () => s.sources,
    listNodes: () => s.nodes,
    saveSource: src => { s.sources = [...s.sources, src]; },
    deleteSource: id => {
      s.sources = s.sources.filter(x => x.id !== id);
      s.nodes = s.nodes.filter(n => n.sourceId !== id);
    },
    saveNodes: (sourceId, nodes) => { s.nodes = [...s.nodes.filter(n => n.sourceId !== sourceId), ...nodes]; },
    saveProxyBackup: (id, content) => { s.backups = { ...s.backups, [id]: content }; },
    saveEnv: env => { s.envs = [...s.envs, env]; },
    deleteEnv: id => { s.envs = s.envs.filter(e => e.id !== id); },
    newId: genId,
  };
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function listFiles(root: string, rel = ''): string[] {
  if (!fs.existsSync(path.join(root, rel))) return [];
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(e => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(root, child) : [child];
  }).sort();
}

let tmp: string;
let machineA: BundleDirs;
let machineB: BundleDirs;
let bundlePath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirage-bundle-'));
  machineA = { userDataDir: path.join(tmp, 'a'), tmpDir: path.join(tmp, 'a', 'tmp') };
  machineB = { userDataDir: path.join(tmp, 'b'), tmpDir: path.join(tmp, 'b', 'tmp') };
  fs.mkdirSync(machineB.userDataDir, { recursive: true });
  bundlePath = path.join(tmp, 'out.mirage');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sourceStore(): FakeStore {
  const s = emptyStore();
  s.sources = [makeSource()];
  s.nodes = [
    makeNode({ delay: 120 }),
    makeNode({ id: 'node-2', name: 'JP-01', rawYaml: '- name: JP-01\n  type: ss\n  server: 2.2.2.2\n  port: 443' }),
  ];
  s.envs = [
    makeEnv({ id: 'env-1', name: '甲', proxyMode: 'mihomo', proxySourceId: 'src-1', proxyNodeId: 'node-2' }),
    makeEnv({ id: 'env-2', name: '乙', proxyMode: 'simple', proxySimple: 'socks5://u:p@1.2.3.4:1080' }),
  ];
  return s;
}

function seedProfile(envId: string): string {
  const dataDir = path.join(machineA.userDataDir, 'profiles', envId, 'chrome_data');
  writeFile(path.join(dataDir, 'Local State'), '{"os_crypt":{}}');
  writeFile(path.join(dataDir, 'Default', 'Cookies'), 'cookie-db');
  writeFile(path.join(dataDir, 'Default', 'Local Storage', 'leveldb', 'CURRENT'), 'MANIFEST-1');
  writeFile(path.join(dataDir, 'Default', 'Cache', 'Cache_Data', 'f_1'), 'x'.repeat(4096));
  writeFile(path.join(dataDir, 'GrShaderCache', 'data_0'), 'shader');
  writeFile(path.join(machineA.userDataDir, 'profiles', envId, 'mihomo.yaml'), 'temp');
  if (process.platform !== 'win32') {
    fs.symlinkSync('host-1234', path.join(dataDir, 'SingletonLock'));
  }
  return dataDir;
}

describe('导出 → 导入往返', () => {
  it('仅配置：生成新 ID，保留指纹，代理源重建并写入 mihomo 备份', async () => {
    const a = sourceStore();
    const res = await exportBundle(
      { envIds: ['env-1', 'env-2'], includeProfile: false, targetPath: bundlePath, appVersion: '0.0.2' },
      exportDeps(a), machineA,
    );
    expect(res).toMatchObject({ filePath: bundlePath, count: 2 });
    expect(res.bytes).toBeGreaterThan(0);
    expect(fs.readdirSync(machineA.tmpDir)).toEqual([]);

    const manifest = await readBundleManifest(bundlePath);
    expect(manifest).toMatchObject({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, includesProfile: false, appVersion: '0.0.2' });
    expect(manifest.items[0].proxy?.nodes.map(n => n.name)).toEqual(['HK-01', 'JP-01']);
    expect(manifest.items[0].proxy?.nodes[0]).not.toHaveProperty('delay');

    const b = emptyStore();
    const out = await applyBundle(bundlePath, manifest, importDeps(b), machineB);
    expect(out.createdSources).toBe(1);
    expect(b.envs.map(e => e.name)).toEqual(['甲', '乙']);
    expect(b.envs.every(e => e.id.startsWith('imp-'))).toBe(true);
    expect(b.envs[0].fingerprint).toEqual(a.envs[0].fingerprint);
    expect(b.envs[0].createdAt < b.envs[1].createdAt).toBe(true);

    const [src] = b.sources;
    const node = b.nodes.find(n => n.id === b.envs[0].proxyNodeId);
    expect(b.envs[0].proxySourceId).toBe(src.id);
    expect(node).toMatchObject({ name: 'JP-01', sourceId: src.id });
    const backup = yaml.load(b.backups[src.id]) as { proxies: Array<{ name: string }> };
    expect(backup.proxies.map(p => p.name)).toEqual(['HK-01', 'JP-01']);
    expect(b.envs[1]).toMatchObject({ proxyMode: 'simple', proxySimple: 'socks5://u:p@1.2.3.4:1080', proxySourceId: '' });
    expect(fs.existsSync(path.join(machineB.userDataDir, 'profiles'))).toBe(false);
  });

  it('包含 Profile：迁移 Chrome 数据，排除缓存、锁文件与 mihomo 临时配置', async () => {
    const a = sourceStore();
    seedProfile('env-1');
    const progress: number[] = [];
    await exportBundle(
      { envIds: ['env-1', 'env-2'], includeProfile: true, targetPath: bundlePath, appVersion: '0.0.2' },
      exportDeps(a), machineA, p => progress.push(p),
    );
    expect(progress[progress.length - 1]).toBe(100);

    const manifest = await readBundleManifest(bundlePath);
    expect(manifest.includesProfile).toBe(true);
    expect(manifest.items.map(it => it.hasProfile)).toEqual([true, false]);

    const b = emptyStore();
    await applyBundle(bundlePath, manifest, importDeps(b), machineB);
    const newId = b.envs[0].id;
    expect(fs.readdirSync(path.join(machineB.userDataDir, 'profiles'))).toEqual([newId]);
    const files = listFiles(path.join(machineB.userDataDir, 'profiles', newId));
    expect(files).toEqual([
      'chrome_data/Default/Cookies',
      'chrome_data/Default/Local Storage/leveldb/CURRENT',
      'chrome_data/Local State',
    ]);
    expect(fs.readFileSync(path.join(machineB.userDataDir, 'profiles', newId, 'chrome_data/Default/Cookies'), 'utf-8')).toBe('cookie-db');
    expect(fs.readdirSync(machineB.tmpDir)).toEqual([]);
  });

  it('导入到已有同 URL 订阅的机器时复用本机节点', async () => {
    const a = sourceStore();
    await exportBundle({ envIds: ['env-1'], includeProfile: false, targetPath: bundlePath, appVersion: '' }, exportDeps(a), machineA);
    const manifest = await readBundleManifest(bundlePath);

    const b = emptyStore();
    b.sources = [makeSource({ id: 'b-src', name: '本机' })];
    b.nodes = [makeNode({ id: 'b-node', sourceId: 'b-src', name: 'JP-01' })];
    expect(buildPreviewItems(manifest, importDeps(b))[0]).toMatchObject({ proxyAction: 'reuse', proxyLabel: '复用本机：本机 - JP-01' });

    const out = await applyBundle(bundlePath, manifest, importDeps(b), machineB);
    expect(out.createdSources).toBe(0);
    expect(b.envs[0]).toMatchObject({ proxySourceId: 'b-src', proxyNodeId: 'b-node' });
  });
});

describe('导入时修改名称与线路', () => {
  it('按覆盖项重命名并改用本机线路，未改的环境保持原样', async () => {
    const a = sourceStore();
    await exportBundle({ envIds: ['env-1', 'env-2'], includeProfile: false, targetPath: bundlePath, appVersion: '' }, exportDeps(a), machineA);
    const manifest = await readBundleManifest(bundlePath);

    const b = emptyStore();
    b.sources = [makeSource({ id: 'b-src', name: '本机', url: 'https://other.example.com' })];
    b.nodes = [makeNode({ id: 'b-node', sourceId: 'b-src', name: 'US-01' })];
    const out = await applyBundle(bundlePath, manifest, importDeps(b), machineB, {
      overrides: [
        { name: '甲-新', proxy: { kind: 'node', nodeId: 'b-node' } },
        { name: '', proxy: { kind: 'keep' } },
      ],
    });
    expect(out.createdSources).toBe(0);
    expect(b.sources.map(s => s.id)).toEqual(['b-src']);
    expect(b.envs[0]).toMatchObject({ name: '甲-新', proxyMode: 'mihomo', proxySourceId: 'b-src', proxyNodeId: 'b-node' });
    expect(b.envs[1]).toMatchObject({ name: '乙', proxyMode: 'simple', proxySimple: 'socks5://u:p@1.2.3.4:1080' });
  });

  it('可将环境改为不使用代理', async () => {
    const a = sourceStore();
    await exportBundle({ envIds: ['env-2'], includeProfile: false, targetPath: bundlePath, appVersion: '' }, exportDeps(a), machineA);
    const manifest = await readBundleManifest(bundlePath);

    const b = emptyStore();
    await applyBundle(bundlePath, manifest, importDeps(b), machineB, { overrides: [{ name: '', proxy: { kind: 'none' } }] });
    expect(b.envs[0]).toMatchObject({ name: '乙', proxyMode: '', proxySimple: '' });
  });

  it('所选线路不存在时不写入任何数据', async () => {
    const a = sourceStore();
    await exportBundle({ envIds: ['env-1'], includeProfile: false, targetPath: bundlePath, appVersion: '' }, exportDeps(a), machineA);
    const manifest = await readBundleManifest(bundlePath);

    const b = emptyStore();
    await expect(applyBundle(bundlePath, manifest, importDeps(b), machineB, {
      overrides: [{ name: '', proxy: { kind: 'node', nodeId: 'gone' } }],
    })).rejects.toThrow(/所选线路不存在/);
    expect(b.envs).toEqual([]);
    expect(b.sources).toEqual([]);
  });
});

describe('导出校验', () => {
  it('导出浏览器数据时拒绝运行中的环境', async () => {
    const a = sourceStore();
    await expect(exportBundle(
      { envIds: ['env-1'], includeProfile: true, targetPath: bundlePath, appVersion: '' }, exportDeps(a, ['env-1']), machineA,
    )).rejects.toThrow(/请先关闭正在运行的环境/);
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  it('仅导出配置时允许运行中的环境', async () => {
    const a = sourceStore();
    await exportBundle({ envIds: ['env-1'], includeProfile: false, targetPath: bundlePath, appVersion: '' }, exportDeps(a, ['env-1']), machineA);
    expect(fs.existsSync(bundlePath)).toBe(true);
  });

  it('没有有效环境时报错', async () => {
    await expect(exportBundle(
      { envIds: ['nope'], includeProfile: false, targetPath: bundlePath, appVersion: '' }, exportDeps(emptyStore()), machineA,
    )).rejects.toThrow('没有可导出的环境');
  });

  it('collectProxy 在节点或源缺失时返回 undefined', () => {
    const env = makeEnv({ proxyMode: 'mihomo', proxyNodeId: 'node-1' });
    expect(collectProxy(env, [], [makeNode()])).toBeUndefined();
    expect(collectProxy(env, [makeSource()], [])).toBeUndefined();
    expect(collectProxy(makeEnv(), [makeSource()], [makeNode()])).toBeUndefined();
  });
});

describe('导入安全', () => {
  function manifestJson(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      format: BUNDLE_FORMAT, version: 1, appVersion: '', exportedAt: '', includesProfile: true,
      items: [{ env: makeEnv({ id: 'env-1' }), hasProfile: true }],
      ...over,
    });
  }

  it('拒绝非 tar 文件与缺少清单的包', async () => {
    fs.writeFileSync(bundlePath, 'not a tarball');
    await expect(readBundleManifest(bundlePath)).rejects.toThrow(/不是有效的 Mirage 环境包/);
    fs.writeFileSync(bundlePath, buildRawTarGz([{ path: 'other.txt', content: 'x' }]));
    await expect(readBundleManifest(bundlePath)).rejects.toThrow(/缺少 manifest.json/);
  });

  it('拒绝非法 JSON 与不合规清单', async () => {
    fs.writeFileSync(bundlePath, buildRawTarGz([{ path: 'manifest.json', content: '{oops' }]));
    await expect(readBundleManifest(bundlePath)).rejects.toThrow(/不是合法 JSON/);
    fs.writeFileSync(bundlePath, buildRawTarGz([{ path: 'manifest.json', content: manifestJson({ version: 99 }) }]));
    await expect(readBundleManifest(bundlePath)).rejects.toThrow(/请升级应用/);
  });

  it('只解出白名单内的普通文件，忽略路径穿越、符号链接和其他环境的数据', async () => {
    fs.writeFileSync(bundlePath, buildRawTarGz([
      { path: 'manifest.json', content: manifestJson() },
      { path: 'profiles/env-1/chrome_data/Default/Cookies', content: 'ok' },
      { path: 'profiles/env-1/../../../escape.txt', content: 'evil' },
      { path: '/abs-escape.txt', content: 'evil' },
      { path: 'profiles/env-1/chrome_data/link', type: '2', linkpath: '/etc/passwd' },
      { path: 'profiles/other/chrome_data/x', content: 'evil' },
      { path: 'escape-root.txt', content: 'evil' },
    ]));
    const manifest = await readBundleManifest(bundlePath);
    const b = emptyStore();
    await applyBundle(bundlePath, manifest, importDeps(b), machineB);

    const newId = b.envs[0].id;
    expect(listFiles(machineB.userDataDir)).toEqual([`profiles/${newId}/chrome_data/Default/Cookies`]);
    expect(listFiles(tmp).filter(f => f.includes('escape'))).toEqual([]);
  });

  it('写入失败时回滚已创建的环境、代理源与 Profile 目录', async () => {
    const a = sourceStore();
    seedProfile('env-1');
    await exportBundle({ envIds: ['env-1', 'env-2'], includeProfile: true, targetPath: bundlePath, appVersion: '' }, exportDeps(a), machineA);
    const manifest = await readBundleManifest(bundlePath);

    const b = emptyStore();
    const deps = importDeps(b);
    let calls = 0;
    const failing: ImportDeps = {
      ...deps,
      saveEnv: env => {
        calls += 1;
        if (calls === 2) throw new Error('磁盘已满');
        deps.saveEnv(env);
      },
    };
    await expect(applyBundle(bundlePath, manifest, failing, machineB)).rejects.toThrow('磁盘已满');
    expect(b.envs).toEqual([]);
    expect(b.sources).toEqual([]);
    expect(b.nodes).toEqual([]);
    expect(listFiles(path.join(machineB.userDataDir, 'profiles'))).toEqual([]);
    expect(fs.readdirSync(machineB.tmpDir)).toEqual([]);
  });
});

describe('maskProxyCredentials', () => {
  it('隐藏账号密码', () => {
    expect(maskProxyCredentials('socks5://u:p@1.2.3.4:1080')).toBe('socks5://***@1.2.3.4:1080');
    expect(maskProxyCredentials('http://1.2.3.4:8080')).toBe('http://1.2.3.4:8080');
  });
});
