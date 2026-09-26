// 导出环境为 .mirage 包（tar.gz）：manifest.json + 可选的 profiles/<envId>/chrome_data

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import type { Environment, ProxySource, ProxyNode, ExportEnvResult } from '../../types';
import {
  BUNDLE_FORMAT, BUNDLE_VERSION, MANIFEST_FILE, MAX_BUNDLE_ITEMS, PROFILE_ROOT, PROFILE_DATA_DIR,
  profileDataPath, type BundleItem, type BundleManifest, type BundleProxy,
} from './manifest';
import { shouldIncludeProfileEntry } from './profile-filter';

export interface BundleDirs {
  /** 应用 userData 目录，其下 profiles/<envId>/chrome_data 为 Chrome 数据 */
  userDataDir: string;
  /** 临时工作目录，需与 userDataDir 在同一磁盘以便 rename */
  tmpDir: string;
}

export interface ExportDeps {
  getEnv(id: string): Environment | null;
  listSources(): ProxySource[];
  listNodes(): ProxyNode[];
  isRunning(envId: string): boolean;
}

export interface ExportRequest {
  envIds: readonly string[];
  includeProfile: boolean;
  targetPath: string;
  appVersion: string;
}

const PROFILE_DATA_RE = new RegExp(`^${PROFILE_ROOT}/[^/]+/${PROFILE_DATA_DIR}(?:/(.*))?$`);

function resolveEnvs(req: ExportRequest, deps: ExportDeps): Environment[] {
  const envs = req.envIds.map(id => deps.getEnv(id)).filter((e): e is Environment => e !== null);
  if (envs.length === 0) throw new Error('没有可导出的环境');
  if (envs.length > MAX_BUNDLE_ITEMS) throw new Error(`单次最多导出 ${MAX_BUNDLE_ITEMS} 个环境`);
  if (req.includeProfile) {
    const running = envs.filter(e => deps.isRunning(e.id)).map(e => e.name);
    if (running.length > 0) {
      throw new Error(`请先关闭正在运行的环境再导出浏览器数据：${running.join('、')}`);
    }
  }
  return envs;
}

/** 导出引用节点所在的整个代理源，方便导入后切换节点；测速结果属于本机数据，不导出 */
export function collectProxy(env: Environment, sources: readonly ProxySource[], nodes: readonly ProxyNode[]): BundleProxy | undefined {
  if (env.proxyMode !== 'mihomo' || !env.proxyNodeId) return undefined;
  const node = nodes.find(n => n.id === env.proxyNodeId);
  const source = node ? sources.find(s => s.id === node.sourceId) : undefined;
  if (!source) return undefined;
  const sourceNodes = nodes
    .filter(n => n.sourceId === source.id)
    .map(({ id, sourceId, name, type, server, port, rawYaml }) => ({ id, sourceId, name, type, server, port, rawYaml }));
  return { source: { ...source, nodeCount: sourceNodes.length }, nodes: sourceNodes };
}

function profileSize(root: string, rel = ''): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.reduce((sum, e) => {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (!shouldIncludeProfileEntry(childRel)) return sum;
    if (e.isDirectory()) return sum + profileSize(root, childRel);
    if (!e.isFile()) return sum;
    try { return sum + fs.lstatSync(path.join(root, childRel)).size; } catch { return sum; }
  }, 0);
}

function isFsStats(v: unknown): v is fs.Stats {
  return typeof (v as fs.Stats).isFile === 'function';
}

function makePackFilter(totalBytes: number, onProgress?: (percent: number) => void) {
  let packed = 0;
  let lastPercent = -1;
  return (p: string, stat: unknown): boolean => {
    const normalized = p.replace(/\\/g, '/');
    if (normalized === MANIFEST_FILE) return true;
    const m = PROFILE_DATA_RE.exec(normalized);
    if (!m || !shouldIncludeProfileEntry(m[1] ?? '')) return false;
    if (isFsStats(stat)) {
      // 符号链接、socket 等特殊文件不导出
      if (!stat.isFile() && !stat.isDirectory()) return false;
      if (stat.isFile()) {
        packed += stat.size;
        const percent = totalBytes > 0 ? Math.min(99, Math.floor((packed / totalBytes) * 100)) : 99;
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress?.(percent);
        }
      }
    }
    return true;
  };
}

export async function exportBundle(
  req: ExportRequest,
  deps: ExportDeps,
  dirs: BundleDirs,
  onProgress?: (percent: number) => void,
): Promise<ExportEnvResult> {
  const envs = resolveEnvs(req, deps);
  const sources = deps.listSources();
  const nodes = deps.listNodes();
  const items: BundleItem[] = envs.map(env => ({
    env,
    proxy: collectProxy(env, sources, nodes),
    hasProfile: req.includeProfile && fs.existsSync(path.join(dirs.userDataDir, profileDataPath(env.id))),
  }));
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    appVersion: req.appVersion,
    exportedAt: new Date().toISOString(),
    includesProfile: items.some(it => it.hasProfile),
    items,
  };

  const workDir = path.join(dirs.tmpDir, `export-${crypto.randomUUID()}`);
  const tmpTarget = `${req.targetPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(workDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(workDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8');
    // 清单与 Profile 位于不同目录：先单独打一个清单 tar，再以 @ 方式并入最终包，保证清单排在最前
    const manifestTar = path.join(workDir, 'manifest.tar');
    await tar.c({ file: manifestTar, cwd: workDir, portable: true }, [MANIFEST_FILE]);

    const profilePaths = items.filter(it => it.hasProfile).map(it => profileDataPath(it.env.id));
    const totalBytes = profilePaths.reduce((sum, p) => sum + profileSize(path.join(dirs.userDataDir, p)), 0);
    await tar.c(
      { file: tmpTarget, gzip: true, cwd: dirs.userDataDir, portable: true, filter: makePackFilter(totalBytes, onProgress) },
      [`@${manifestTar}`, ...profilePaths],
    );
    fs.renameSync(tmpTarget, req.targetPath);
    onProgress?.(100);
    return { filePath: req.targetPath, count: items.length, bytes: fs.statSync(req.targetPath).size };
  } catch (e) {
    fs.rmSync(tmpTarget, { force: true });
    throw e;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
