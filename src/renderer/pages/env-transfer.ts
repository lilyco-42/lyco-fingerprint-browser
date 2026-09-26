// 环境导入/导出：导出选项弹窗、导入预览弹窗与进度展示

import type {
  Environment, ImportItemOverride, ImportPreview, ProxyNode, ProxySource, TransferProgress,
} from '../../types';
import { showModal, showConfirm } from '../modal';
import { toast } from '../toast';

const api = window.api;

/** 结束 Chrome 后等待其落盘，避免导出到写了一半的 Cookie 数据库 */
const CLOSE_SETTLE_MS = 1500;

export interface EnvTransferContext {
  getSelectedIds(): string[];
  findEnv(id: string): Environment | undefined;
  isRunning(id: string): boolean;
  closeEnv(id: string): Promise<void>;
  /** 导入完成后刷新环境列表、代理源等 */
  onImported(): Promise<void>;
}

const btnExport = document.getElementById('btn-export-selected') as HTMLButtonElement;
const btnImport = document.getElementById('btn-import-envs') as HTMLButtonElement;
const statusMsg = document.getElementById('status-msg') as HTMLElement;

const STAGE_LABEL: Record<TransferProgress['stage'], string> = { export: '正在导出', import: '正在导入' };

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '未知时间' : d.toLocaleString();
}

async function runBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  btnExport.disabled = true;
  btnImport.disabled = true;
  statusMsg.textContent = `${label}...`;
  try {
    return await fn();
  } finally {
    btnExport.disabled = false;
    btnImport.disabled = false;
    statusMsg.textContent = '就绪';
  }
}

// ── 导出 ──────────────────────────────────

function askExportOptions(count: number): Promise<{ includeProfile: boolean } | null> {
  return showModal<{ includeProfile: boolean }>('导出环境', (body, resolve) => {
    body.innerHTML = `<div class="modal-form transfer-form">
      <p style="margin-top:0">将导出选中的 <b>${count}</b> 个环境（指纹、UA、首页、备注及代理配置）。</p>
      <div class="field-row">
        <input type="checkbox" id="m-include-profile" />
        <label for="m-include-profile">包含浏览器数据（Cookie、登录态、扩展、书签、历史记录等）</label>
      </div>
      <ul class="transfer-hint">
        <li>⚠️ 导出文件含代理账号与订阅地址；勾选浏览器数据后还包含登录凭据，请妥善保管。</li>
        <li>浏览器数据只能在相同操作系统之间迁移；Windows 上迁移到其他电脑或用户后 Cookie 与已保存的密码会失效。</li>
        <li>导出浏览器数据前需要关闭对应环境，缓存文件不会被导出。</li>
      </ul>
      <div class="modal-footer">
        <button id="m-ok">导出</button>
        <button id="m-cancel">取消</button>
      </div>
    </div>`;
    const chk = body.querySelector('#m-include-profile') as HTMLInputElement;
    body.querySelector('#m-ok')!.addEventListener('click', () => resolve({ includeProfile: chk.checked }));
    body.querySelector('#m-cancel')!.addEventListener('click', () => resolve(null as unknown as { includeProfile: boolean }));
  });
}

/** 导出浏览器数据时，确认并关闭仍在运行的环境；用户取消则返回 false */
async function ensureClosed(ctx: EnvTransferContext, ids: string[]): Promise<boolean> {
  const running = ids.filter(id => ctx.isRunning(id));
  if (running.length === 0) return true;
  const names = running.map(id => ctx.findEnv(id)?.name ?? id).join('、');
  const ok = await showConfirm(`导出浏览器数据需要先关闭以下运行中的环境：${names}。是否关闭并继续？`);
  if (!ok) return false;
  for (const id of running) await ctx.closeEnv(id);
  await new Promise(r => setTimeout(r, CLOSE_SETTLE_MS));
  return true;
}

async function exportSelected(ctx: EnvTransferContext): Promise<void> {
  const ids = ctx.getSelectedIds();
  if (ids.length === 0) {
    toast('请先勾选要导出的环境', 'error');
    return;
  }
  const opts = await askExportOptions(ids.length);
  if (!opts) return;
  if (opts.includeProfile && !(await ensureClosed(ctx, ids))) return;

  try {
    const result = await runBusy(STAGE_LABEL.export, () => api.envExport(ids, opts));
    if (!result) return;
    toast(`已导出 ${result.count} 个环境（${formatBytes(result.bytes)}）`, 'success', 5000);
  } catch (e) {
    toast(`导出失败: ${(e as Error).message}`, 'error', 6000);
  }
}

// ── 导入 ──────────────────────────────────

const LINE_KEEP = '__keep';
const LINE_NONE = '__none';
/** 与主进程 import-overrides 的名称长度校验保持一致 */
const MAX_NAME_LENGTH = 256;

/** 本机可选线路：只列出有节点的代理源 */
interface LineOptions {
  sources: ProxySource[];
  nodesBySource: Map<string, ProxyNode[]>;
}

async function loadLineOptions(): Promise<LineOptions> {
  try {
    const [sources, nodes] = await Promise.all([api.proxySources(), api.proxyNodes()]);
    const nodesBySource = new Map(sources.map(s => [s.id, nodes.filter(n => n.sourceId === s.id)]));
    return { sources: sources.filter(s => (nodesBySource.get(s.id)?.length ?? 0) > 0), nodesBySource };
  } catch (e) {
    toast(`读取本机线路失败，只能保持原配置: ${(e as Error).message}`, 'error', 6000);
    return { sources: [], nodesBySource: new Map() };
  }
}

function sourceSelectHtml(lines: LineOptions): string {
  const local = lines.sources.length === 0 ? '' : `<optgroup label="改用本机线路">${
    lines.sources.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`).join('')
  }</optgroup>`;
  return `<select class="imp-source">
    <option value="${LINE_KEEP}">保持原配置</option>
    <option value="${LINE_NONE}">不使用代理</option>
    ${local}
  </select>`;
}

function previewRowsHtml(preview: ImportPreview, lines: LineOptions): string {
  return preview.items.map((it, i) => {
    const origin = it.proxyAction === 'none' ? '无代理' : it.proxyLabel;
    return `<tr>
      <td>${i + 1}</td>
      <td><input type="text" class="imp-name" maxlength="${MAX_NAME_LENGTH}" value="${escHtml(it.name)}" placeholder="${escHtml(it.name)}" /></td>
      <td>
        <div class="imp-line">${sourceSelectHtml(lines)}<select class="imp-node" style="display:none"></select></div>
        <div class="imp-origin ${it.proxyAction === 'missing' ? 'transfer-warn' : ''}" title="${escHtml(origin)}">原配置：${escHtml(origin)}</div>
      </td>
      <td style="text-align:center">${it.hasProfile ? '✔' : '—'}</td>
    </tr>`;
  }).join('');
}

/** 选择代理源后填充该源的节点列表；选择「保持/不使用」时隐藏节点下拉框 */
function bindLineSelects(body: HTMLElement, lines: LineOptions): void {
  body.querySelectorAll<HTMLTableRowElement>('.transfer-table-wrap tbody tr').forEach(row => {
    const srcSel = row.querySelector('.imp-source') as HTMLSelectElement;
    const nodeSel = row.querySelector('.imp-node') as HTMLSelectElement;
    srcSel.addEventListener('change', () => {
      const nodes = lines.nodesBySource.get(srcSel.value);
      nodeSel.style.display = nodes ? '' : 'none';
      nodeSel.innerHTML = nodes
        ? '<option value="">— 选择节点 —</option>' + nodes.map(n => `<option value="${escHtml(n.id)}">${escHtml(n.name)}</option>`).join('')
        : '';
    });
  });
}

/** 读取每行的名称与线路；有未选节点的行时返回错误提示 */
function readOverrides(body: HTMLElement): ImportItemOverride[] | string {
  const rows = [...body.querySelectorAll<HTMLTableRowElement>('.transfer-table-wrap tbody tr')];
  const overrides: ImportItemOverride[] = [];
  for (const [i, row] of rows.entries()) {
    const name = (row.querySelector('.imp-name') as HTMLInputElement).value.trim();
    const source = (row.querySelector('.imp-source') as HTMLSelectElement).value;
    const nodeId = (row.querySelector('.imp-node') as HTMLSelectElement).value;
    if (source === LINE_KEEP) overrides.push({ name, proxy: { kind: 'keep' } });
    else if (source === LINE_NONE) overrides.push({ name, proxy: { kind: 'none' } });
    else if (nodeId) overrides.push({ name, proxy: { kind: 'node', nodeId } });
    else return `请为第 ${i + 1} 个环境选择线路节点`;
  }
  return overrides;
}

function confirmImport(preview: ImportPreview, lines: LineOptions): Promise<ImportItemOverride[] | null> {
  const hasMissing = preview.items.some(it => it.proxyAction === 'missing');
  return showModal<ImportItemOverride[]>('导入环境预览', (body, resolve) => {
    body.innerHTML = `<div class="modal-form transfer-form transfer-form-wide">
      <p style="margin-top:0">
        文件：<b>${escHtml(preview.fileName)}</b><br />
        导出于 ${escHtml(formatTime(preview.exportedAt))}${preview.appVersion ? `，应用版本 v${escHtml(preview.appVersion)}` : ''}，共 ${preview.items.length} 个环境
      </p>
      <div class="transfer-table-wrap">
        <table class="xp-table">
          <thead><tr><th style="width:32px">#</th><th style="width:190px">环境名称</th><th>线路</th><th style="width:84px">浏览器数据</th></tr></thead>
          <tbody>${previewRowsHtml(preview, lines)}</tbody>
        </table>
      </div>
      <ul class="transfer-hint">
        <li>可直接修改环境名称（留空则使用原名称），并为每个环境改用本机已有的线路。</li>
        <li>导入的环境会分配新 ID，不会覆盖现有环境。</li>
        ${hasMissing ? '<li class="transfer-warn">⚠️ 部分环境的代理节点在导出文件中缺失，请为其选择本机线路，或导入后在“编辑”中重新选择。</li>' : ''}
      </ul>
      <div class="modal-footer">
        <button id="m-ok">导入</button>
        <button id="m-cancel">取消</button>
      </div>
    </div>`;
    bindLineSelects(body, lines);
    body.querySelector('#m-ok')!.addEventListener('click', () => {
      const result = readOverrides(body);
      if (typeof result === 'string') toast(result, 'error');
      else resolve(result);
    });
    body.querySelector('#m-cancel')!.addEventListener('click', () => resolve(null as unknown as ImportItemOverride[]));
  });
}

async function importEnvs(ctx: EnvTransferContext): Promise<void> {
  let preview: ImportPreview | null;
  try {
    preview = await api.envImportPreview();
  } catch (e) {
    toast(`读取导入文件失败: ${(e as Error).message}`, 'error', 6000);
    return;
  }
  if (!preview) return;

  const overrides = await confirmImport(preview, await loadLineOptions());
  if (!overrides) {
    await api.envImportCancel(preview.token);
    return;
  }

  try {
    const token = preview.token;
    const result = await runBusy(STAGE_LABEL.import, () => api.envImportApply(token, overrides));
    await ctx.onImported();
    const extra = result.createdSources > 0 ? `，新建 ${result.createdSources} 个代理源` : '';
    toast(`已导入 ${result.imported.length} 个环境${extra}`, 'success', 5000);
  } catch (e) {
    toast(`导入失败: ${(e as Error).message}`, 'error', 6000);
  }
}

export function init(ctx: EnvTransferContext): void {
  btnExport.addEventListener('click', () => { void exportSelected(ctx); });
  btnImport.addEventListener('click', () => { void importEnvs(ctx); });
  api.onEnvTransferProgress(({ stage, percent }) => {
    statusMsg.textContent = `${STAGE_LABEL[stage]}... ${percent}%`;
  });
}
