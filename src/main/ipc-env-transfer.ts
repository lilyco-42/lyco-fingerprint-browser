// 环境导入/导出的 IPC 处理：文件对话框、参数校验、进度推送与待导入会话管理

import { ipcMain, dialog, BrowserWindow, app, type WebContents } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ExportEnvResult, ImportPreview, ImportEnvResult, TransferProgress } from '../types';
import * as store from './store';
import { getAllRuntimes } from './chrome-manager';
import { saveSubscriptionBackup } from './mihomo-manager';
import { exportBundle, type BundleDirs } from './env-bundle/exporter';
import { readBundleManifest } from './env-bundle/bundle-reader';
import { applyBundle, buildPreviewItems, type ImportDeps } from './env-bundle/importer';
import { parseImportOverrides } from './env-bundle/import-overrides';
import { BUNDLE_EXTENSION, MAX_BUNDLE_ITEMS, type BundleManifest } from './env-bundle/manifest';

interface PendingImport {
  token: string;
  filePath: string;
  manifest: BundleManifest;
}

const FILE_FILTERS = [{ name: 'Mirage 环境包', extensions: [BUNDLE_EXTENSION] }];
const MAX_FILENAME_LENGTH = 80;

/** 同一时间只保留一个待确认的导入，渲染进程只持有 token，拿不到也传不回文件路径 */
let pendingImport: PendingImport | null = null;
let busy = false;

const importDeps: ImportDeps = {
  listSources: () => store.listSources(),
  listNodes: () => store.listNodes(),
  saveSource: s => { store.saveSource(s); },
  deleteSource: id => store.deleteSource(id),
  saveNodes: (id, nodes) => store.saveNodes(id, nodes),
  saveProxyBackup: (id, content) => saveSubscriptionBackup(id, content),
  saveEnv: env => { store.saveEnv(env); },
  deleteEnv: id => store.deleteEnv(id),
  newId: () => store.newId(),
};

function bundleDirs(): BundleDirs {
  const userDataDir = app.getPath('userData');
  return { userDataDir, tmpDir: path.join(userDataDir, 'tmp') };
}

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('已有导入/导出任务正在进行，请稍候');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

function progressSender(sender: WebContents, stage: TransferProgress['stage']): (percent: number) => void {
  return percent => {
    if (!sender.isDestroyed()) sender.send('env:transferProgress', { stage, percent });
  };
}

function parseEnvIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BUNDLE_ITEMS) {
    throw new Error(`请选择 1~${MAX_BUNDLE_ITEMS} 个环境`);
  }
  if (!raw.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    throw new Error('环境 ID 无效');
  }
  return [...new Set(raw as string[])];
}

function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, MAX_FILENAME_LENGTH);
  return cleaned || 'mirage-env';
}

function defaultExportName(envIds: string[]): string {
  if (envIds.length === 1) {
    const env = store.getEnv(envIds[0]);
    if (env) return `${sanitizeFileName(env.name)}.${BUNDLE_EXTENSION}`;
  }
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `mirage-envs-${envIds.length}-${date}.${BUNDLE_EXTENSION}`;
}

async function handleExport(sender: WebContents, rawIds: unknown, rawOpts: unknown): Promise<ExportEnvResult | null> {
  const envIds = parseEnvIds(rawIds);
  const includeProfile = (rawOpts as { includeProfile?: unknown } | null)?.includeProfile === true;
  const win = BrowserWindow.fromWebContents(sender);
  const dialogOpts = {
    title: '导出环境',
    defaultPath: path.join(app.getPath('downloads'), defaultExportName(envIds)),
    filters: FILE_FILTERS,
  };
  const result = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
  if (result.canceled || !result.filePath) return null;

  const runtimes = getAllRuntimes();
  return exclusive(() => exportBundle(
    { envIds, includeProfile, targetPath: result.filePath as string, appVersion: app.getVersion() },
    {
      getEnv: id => store.getEnv(id),
      listSources: () => store.listSources(),
      listNodes: () => store.listNodes(),
      isRunning: id => runtimes[id]?.running === true,
    },
    bundleDirs(),
    progressSender(sender, 'export'),
  ));
}

async function handleImportPreview(sender: WebContents): Promise<ImportPreview | null> {
  const win = BrowserWindow.fromWebContents(sender);
  const dialogOpts = { title: '导入环境', properties: ['openFile' as const], filters: FILE_FILTERS };
  const result = win ? await dialog.showOpenDialog(win, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
  if (result.canceled || !result.filePaths[0]) return null;

  const filePath = result.filePaths[0];
  const manifest = await readBundleManifest(filePath);
  const token = crypto.randomUUID();
  pendingImport = { token, filePath, manifest };
  return {
    token,
    fileName: path.basename(filePath),
    appVersion: manifest.appVersion,
    exportedAt: manifest.exportedAt,
    includesProfile: manifest.includesProfile,
    items: buildPreviewItems(manifest, importDeps),
  };
}

function getPendingImport(token: unknown): PendingImport {
  if (typeof token !== 'string' || !pendingImport || pendingImport.token !== token) {
    throw new Error('导入会话已失效，请重新选择文件');
  }
  return pendingImport;
}

export function registerEnvTransferHandlers(): void {
  ipcMain.handle('env:export', (e, ids: unknown, opts: unknown) => handleExport(e.sender, ids, opts));

  ipcMain.handle('env:importPreview', e => handleImportPreview(e.sender));

  ipcMain.handle('env:importApply', (e, token: unknown, rawOverrides: unknown): Promise<ImportEnvResult> => {
    const { filePath, manifest } = getPendingImport(token);
    // 先校验参数再消费会话，参数有误时用户仍可修改后重试
    const overrides = parseImportOverrides(rawOverrides, manifest.items.length);
    pendingImport = null;
    return exclusive(() => applyBundle(filePath, manifest, importDeps, bundleDirs(), {
      overrides,
      onProgress: progressSender(e.sender, 'import'),
    }));
  });

  ipcMain.handle('env:importCancel', (_e, token: unknown) => {
    if (pendingImport && pendingImport.token === token) pendingImport = null;
  });
}
