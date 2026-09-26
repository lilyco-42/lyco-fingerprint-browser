// 读取 .mirage 包：只读清单 / 解出 Profile 数据，全程按不可信输入处理

import fs from 'node:fs';
import * as tar from 'tar';
import { MANIFEST_FILE, profilePrefix, validateManifest, type BundleManifest } from './manifest';
import { isSafeEntry } from './path-guard';

export const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACT_BYTES = 10 * 1024 ** 3;
export const MAX_EXTRACT_ENTRIES = 500_000;

const INVALID_BUNDLE = '文件不是有效的 Mirage 环境包';

function normalizeEntryPath(p: string): string {
  return p.replace(/^(\.\/)+/, '');
}

/** 流式读取清单，读到后立即停止，不解压包内其余数据 */
export function readBundleManifest(filePath: string): Promise<BundleManifest> {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    const parser = new tar.Parse();
    let settled = false;

    const finish = (err: Error | null, value?: BundleManifest): void => {
      if (settled) return;
      settled = true;
      input.destroy();
      if (err) reject(err); else resolve(value as BundleManifest);
    };

    parser.on('entry', (entry: tar.ReadEntry) => {
      if (settled || normalizeEntryPath(entry.path) !== MANIFEST_FILE || entry.type !== 'File') {
        entry.resume();
        return;
      }
      if ((entry.size ?? 0) > MAX_MANIFEST_BYTES) {
        finish(new Error(`${INVALID_BUNDLE}（清单过大）`));
        return;
      }
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          finish(new Error(`${INVALID_BUNDLE}（清单不是合法 JSON）`));
          return;
        }
        try { finish(null, validateManifest(raw)); } catch (e) { finish(e as Error); }
      });
    });
    parser.on('end', () => finish(new Error(`${INVALID_BUNDLE}（缺少 ${MANIFEST_FILE}）`)));
    parser.on('error', (e: Error) => finish(new Error(`${INVALID_BUNDLE}：${e.message}`)));
    input.on('error', (e: Error) => finish(e));
    input.pipe(parser);
  });
}

/**
 * 把指定环境的 Profile 解到 stagingDir（布局为 profiles/<envId>/chrome_data/...）。
 * 只解出白名单前缀下的普通文件和目录，超出体积或条目数上限立即中止。
 */
export function extractProfiles(
  filePath: string,
  envIds: readonly string[],
  stagingDir: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const allowed = envIds.map(profilePrefix);
  const totalSize = fs.statSync(filePath).size || 1;

  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    let settled = false;
    let bytes = 0;
    let entries = 0;
    let rejected = 0;
    let readBytes = 0;
    let lastPercent = -1;

    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      if (rejected > 0) console.warn(`[EnvBundle] 跳过 ${rejected} 个不安全或不相关的包内条目`);
      if (err) { input.destroy(); reject(err); } else resolve();
    };

    const extractor = tar.x({
      cwd: stagingDir,
      strict: true,
      filter: (p: string, entry: tar.ReadEntry) => {
        const normalized = normalizeEntryPath(p);
        if (normalized === MANIFEST_FILE) return false;
        if (!isSafeEntry(normalized, String(entry.type), allowed)) {
          rejected += 1;
          return false;
        }
        entries += 1;
        bytes += entry.size ?? 0;
        if (bytes > MAX_EXTRACT_BYTES || entries > MAX_EXTRACT_ENTRIES) {
          finish(new Error('导入文件解压后体积或文件数超出上限，已中止'));
          return false;
        }
        return true;
      },
    });

    input.on('data', (chunk: Buffer) => {
      readBytes += chunk.length;
      const percent = Math.min(99, Math.floor((readBytes / totalSize) * 100));
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress?.(percent);
      }
    });
    input.on('error', (e: Error) => finish(e));
    extractor.on('error', (e: Error) => finish(new Error(`解压失败：${e.message}`)));
    extractor.on('close', () => finish(null));
    input.pipe(extractor);
  });
}
