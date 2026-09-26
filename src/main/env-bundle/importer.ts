// 导入 .mirage 包：预览 → 解出 Profile → 写入代理源 → 写入环境，任一步失败整体回滚

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Environment, ProxySource, ProxyNode, ImportEnvResult, ImportPreviewItem, ImportItemOverride } from '../../types';
import { PROFILE_ROOT, profileDataPath, type BundleItem, type BundleManifest } from './manifest';
import { planProxyImports, applyProxyResult, buildProxiesYaml, type ProxyImportResult } from './proxy-remap';
import { extractProfiles } from './bundle-reader';
import { overrideName } from './import-overrides';
import type { BundleDirs } from './exporter';

export interface ImportDeps {
  listSources(): ProxySource[];
  listNodes(): ProxyNode[];
  saveSource(source: ProxySource): void;
  deleteSource(id: string): void;
  saveNodes(sourceId: string, nodes: ProxyNode[]): void;
  /** 写入 mihomo 订阅备份，环境启动时 mihomo 从备份读取节点 */
  saveProxyBackup(sourceId: string, content: string): void;
  saveEnv(env: Environment): void;
  deleteEnv(id: string): void;
  newId(): string;
}

export interface ApplyOptions {
  /** 用户在预览中修改的名称与线路，与 manifest.items 一一对应 */
  overrides?: readonly ImportItemOverride[];
  onProgress?: (percent: number) => void;
}

interface CreatedRecord {
  envIds: string[];
  sourceIds: string[];
  profileDirs: string[];
}

/** 隐藏代理地址中的账号密码，例如 socks5://user:pass@host → socks5://***@host */
export function maskProxyCredentials(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//***@');
}

function describeProxy(item: BundleItem, result: ProxyImportResult): string {
  switch (result.action) {
    case 'simple': return maskProxyCredentials(item.env.proxySimple || '?');
    case 'reuse': return `复用本机：${result.sourceName} - ${result.nodeName}`;
    case 'create': return `新建代理源：${result.sourceName} - ${result.nodeName}`;
    case 'missing': return `代理节点缺失${result.sourceName ? `（${result.sourceName}）` : ''}，导入后需重新选择`;
    default: return '—';
  }
}

export function buildPreviewItems(manifest: BundleManifest, deps: Pick<ImportDeps, 'listSources' | 'listNodes'>): ImportPreviewItem[] {
  let seq = 0;
  const plan = planProxyImports(manifest.items, deps.listSources(), deps.listNodes(), () => `preview-${++seq}`, '');
  return manifest.items.map((item, i) => ({
    name: item.env.name,
    proxyMode: item.env.proxyMode,
    proxyAction: plan.results[i].action,
    proxyLabel: describeProxy(item, plan.results[i]),
    hasProfile: item.hasProfile,
  }));
}

function moveProfile(stagingDir: string, oldId: string, userDataDir: string, newId: string, created: CreatedRecord): void {
  const src = path.join(stagingDir, profileDataPath(oldId));
  if (!fs.existsSync(src)) return;
  const dest = path.join(userDataDir, profileDataPath(newId));
  if (fs.existsSync(dest)) throw new Error(`目标 Profile 目录已存在：${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  created.profileDirs.push(path.join(userDataDir, PROFILE_ROOT, newId));
  fs.renameSync(src, dest);
}

function rollback(created: CreatedRecord, deps: ImportDeps): void {
  const attempt = (label: string, fn: () => void): void => {
    try { fn(); } catch (e) { console.error(`[EnvBundle] 回滚${label}失败:`, e); }
  };
  created.envIds.forEach(id => attempt(`环境 ${id}`, () => deps.deleteEnv(id)));
  created.sourceIds.forEach(id => attempt(`代理源 ${id}`, () => deps.deleteSource(id)));
  created.profileDirs.forEach(dir => attempt(`目录 ${dir}`, () => fs.rmSync(dir, { recursive: true, force: true })));
}

export async function applyBundle(
  filePath: string,
  manifest: BundleManifest,
  deps: ImportDeps,
  dirs: BundleDirs,
  { overrides = [], onProgress }: ApplyOptions = {},
): Promise<ImportEnvResult> {
  const now = Date.now();
  const plan = planProxyImports(
    manifest.items, deps.listSources(), deps.listNodes(), () => deps.newId(), new Date(now).toISOString(),
    overrides.map(o => o.proxy),
  );
  const stagingDir = path.join(dirs.tmpDir, `import-${crypto.randomUUID()}`);
  const created: CreatedRecord = { envIds: [], sourceIds: [], profileDirs: [] };

  try {
    const profileEnvIds = manifest.items.filter(it => it.hasProfile).map(it => it.env.id);
    if (profileEnvIds.length > 0) {
      fs.mkdirSync(stagingDir, { recursive: true });
      await extractProfiles(filePath, profileEnvIds, stagingDir, onProgress);
    }

    for (const { source, nodes } of plan.newSources) {
      created.sourceIds.push(source.id);
      deps.saveSource(source);
      deps.saveNodes(source.id, nodes);
      deps.saveProxyBackup(source.id, buildProxiesYaml(nodes));
    }

    const imported = manifest.items.map((item, i) => {
      const newId = deps.newId();
      moveProfile(stagingDir, item.env.id, dirs.userDataDir, newId, created);
      const env: Environment = {
        ...applyProxyResult(item.env, plan.results[i]),
        id: newId,
        name: overrideName(item.env.name, overrides[i]),
        // 逐个错开 1ms，保证列表中保持包内顺序
        createdAt: new Date(now + i).toISOString(),
      };
      created.envIds.push(newId);
      deps.saveEnv(env);
      return env;
    });

    onProgress?.(100);
    return { imported, createdSources: plan.newSources.length };
  } catch (e) {
    rollback(created, deps);
    throw e;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
