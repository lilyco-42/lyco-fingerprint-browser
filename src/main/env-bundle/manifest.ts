// 环境导入/导出包（.mirage）的清单格式与校验
// 清单来自外部文件，属于不可信输入：只保留已知字段，逐项校验类型与长度

import type { Environment, FingerprintConfig, ProxySource, ProxyNode } from '../../types';

export const BUNDLE_FORMAT = 'mirage-env-bundle';
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = 'mirage';
export const MANIFEST_FILE = 'manifest.json';
export const PROFILE_ROOT = 'profiles';
export const MAX_BUNDLE_ITEMS = 100;
export const MAX_NODES_PER_SOURCE = 5000;

export const MAX_SHORT_STR = 256;
const MAX_LONG_STR = 8192;
const MAX_YAML_STR = 65536;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface BundleProxy {
  source: ProxySource;
  nodes: ProxyNode[];
}

export interface BundleItem {
  env: Environment;
  proxy?: BundleProxy;
  /** 包内是否带有该环境的 Chrome Profile（从未启动过的环境没有 Profile） */
  hasProfile: boolean;
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  appVersion: string;
  exportedAt: string;
  includesProfile: boolean;
  items: BundleItem[];
}

type Obj = Record<string, unknown>;

function fail(where: string, msg: string): never {
  throw new Error(`导入文件格式无效：${where} ${msg}`);
}

function asObject(v: unknown, where: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, '应为对象');
  return v as Obj;
}

function str(o: Obj, key: string, where: string, max = MAX_SHORT_STR, fallback?: string): string {
  const v = o[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'string') fail(`${where}.${key}`, '应为字符串');
  if (v.length > max) fail(`${where}.${key}`, `长度超过 ${max}`);
  return v;
}

function num(o: Obj, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}.${key}`, '应为数字');
  return v;
}

function safeId(o: Obj, key: string, where: string): string {
  const v = str(o, key, where);
  if (!SAFE_ID_RE.test(v)) fail(`${where}.${key}`, '包含非法字符');
  return v;
}

const FP_STRING_KEYS = [
  'timezone', 'language', 'platform', 'architecture',
  'networkEffectiveType', 'gpuVendor', 'gpuRenderer',
] as const;

const FP_NUMBER_KEYS = [
  'latitude', 'longitude', 'canvasSeed', 'webglSeed', 'hardwareConcurrency',
  'screenWidth', 'screenHeight', 'colorDepth', 'deviceMemory', 'screenRefreshRate',
  'maxTouchPoints', 'devicePixelRatio', 'batteryLevel',
] as const;

/** 旧版本创建的环境可能缺少部分指纹字段，缺失时跳过，存在时必须类型正确 */
function parseFingerprint(raw: unknown, where: string): FingerprintConfig {
  const o = asObject(raw, where);
  const fp: Obj = {};
  for (const key of FP_STRING_KEYS) {
    if (o[key] !== undefined) fp[key] = str(o, key, where);
  }
  for (const key of FP_NUMBER_KEYS) {
    if (o[key] !== undefined) fp[key] = num(o, key, where);
  }
  if (o['batteryCharging'] !== undefined) {
    if (typeof o['batteryCharging'] !== 'boolean') fail(`${where}.batteryCharging`, '应为布尔值');
    fp['batteryCharging'] = o['batteryCharging'];
  }
  return fp as unknown as FingerprintConfig;
}

function parseProxyMode(o: Obj, where: string): Environment['proxyMode'] {
  const v = str(o, 'proxyMode', where, MAX_SHORT_STR, '');
  if (v !== '' && v !== 'simple' && v !== 'mihomo') fail(`${where}.proxyMode`, '取值无效');
  return v;
}

function parseEnv(raw: unknown, where: string): Environment {
  const o = asObject(raw, where);
  return {
    id: safeId(o, 'id', where),
    name: str(o, 'name', where),
    createdAt: str(o, 'createdAt', where, MAX_SHORT_STR, ''),
    userAgent: str(o, 'userAgent', where, MAX_LONG_STR, ''),
    fingerprint: parseFingerprint(o['fingerprint'], `${where}.fingerprint`),
    proxyMode: parseProxyMode(o, where),
    proxySimple: str(o, 'proxySimple', where, MAX_LONG_STR, ''),
    proxySourceId: str(o, 'proxySourceId', where, MAX_SHORT_STR, ''),
    proxyNodeId: str(o, 'proxyNodeId', where, MAX_SHORT_STR, ''),
    notes: str(o, 'notes', where, MAX_LONG_STR, ''),
    homePage: str(o, 'homePage', where, MAX_LONG_STR, ''),
  };
}

function parseSource(raw: unknown, where: string): ProxySource {
  const o = asObject(raw, where);
  const type = str(o, 'type', where);
  if (type !== 'subscription' && type !== 'file') fail(`${where}.type`, '取值无效');
  return {
    id: str(o, 'id', where),
    name: str(o, 'name', where),
    type,
    url: str(o, 'url', where, MAX_LONG_STR, ''),
    nodeCount: 0,
    lastUpdated: str(o, 'lastUpdated', where, MAX_SHORT_STR, ''),
    createdAt: str(o, 'createdAt', where, MAX_SHORT_STR, ''),
  };
}

function parseNode(raw: unknown, where: string): ProxyNode {
  const o = asObject(raw, where);
  return {
    id: str(o, 'id', where),
    sourceId: str(o, 'sourceId', where),
    name: str(o, 'name', where),
    type: str(o, 'type', where, MAX_SHORT_STR, ''),
    server: str(o, 'server', where, MAX_SHORT_STR, ''),
    port: num(o, 'port', where),
    rawYaml: str(o, 'rawYaml', where, MAX_YAML_STR),
  };
}

function parseProxy(raw: unknown, where: string): BundleProxy | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = asObject(raw, where);
  const source = parseSource(o['source'], `${where}.source`);
  const nodesRaw = o['nodes'];
  if (!Array.isArray(nodesRaw)) fail(`${where}.nodes`, '应为数组');
  if (nodesRaw.length > MAX_NODES_PER_SOURCE) fail(`${where}.nodes`, `数量超过 ${MAX_NODES_PER_SOURCE}`);
  const nodes = nodesRaw.map((n, i) => parseNode(n, `${where}.nodes[${i}]`));
  return { source: { ...source, nodeCount: nodes.length }, nodes };
}

export function validateManifest(raw: unknown): BundleManifest {
  const o = asObject(raw, 'manifest');
  if (o['format'] !== BUNDLE_FORMAT) fail('manifest.format', '不是 Mirage 环境包');
  const version = num(o, 'version', 'manifest');
  if (version > BUNDLE_VERSION) fail('manifest.version', `版本 ${version} 高于当前支持的 ${BUNDLE_VERSION}，请升级应用`);
  if (typeof o['includesProfile'] !== 'boolean') fail('manifest.includesProfile', '应为布尔值');
  const itemsRaw = o['items'];
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) fail('manifest.items', '应为非空数组');
  if (itemsRaw.length > MAX_BUNDLE_ITEMS) fail('manifest.items', `数量超过 ${MAX_BUNDLE_ITEMS}`);

  const items = itemsRaw.map((it, i) => {
    const where = `items[${i}]`;
    const item = asObject(it, where);
    const hasProfile = item['hasProfile'] ?? false;
    if (typeof hasProfile !== 'boolean') fail(`${where}.hasProfile`, '应为布尔值');
    return {
      env: parseEnv(item['env'], `${where}.env`),
      proxy: parseProxy(item['proxy'], `${where}.proxy`),
      hasProfile,
    };
  });

  const ids = new Set(items.map(it => it.env.id));
  if (ids.size !== items.length) fail('manifest.items', '存在重复的环境 ID');

  return {
    format: BUNDLE_FORMAT,
    version,
    appVersion: str(o, 'appVersion', 'manifest', MAX_SHORT_STR, ''),
    exportedAt: str(o, 'exportedAt', 'manifest', MAX_SHORT_STR, ''),
    includesProfile: o['includesProfile'],
    items,
  };
}

export const PROFILE_DATA_DIR = 'chrome_data';

/** 包内某个环境 Profile 的目录前缀，例如 "profiles/<envId>/" */
export function profilePrefix(envId: string): string {
  return `${PROFILE_ROOT}/${envId}/`;
}

/** 包内某个环境 Chrome 数据目录的相对路径，与本机 userData 下的布局一致 */
export function profileDataPath(envId: string): string {
  return `${PROFILE_ROOT}/${envId}/${PROFILE_DATA_DIR}`;
}
