import { toast } from '../toast';
import { loadEnvs } from './envs';

type Account = {
  username: string; pointsBalance: number; proxyActive: boolean; proxyExpiresAt: string | null;
};
type Plan = { code: string; name: string; pointsPrice: number; durationDays: number };
let account: Account | null = null;
let plan: Plan | null = null;
let busy = false;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
function setText(id: string, value: string): void { el(id).textContent = value; }
function update(): void {
  const authorized = Boolean(account);
  el('lyco-login').hidden = authorized;
  el('lyco-account').hidden = !authorized;
  if (account) {
    setText('lyco-username', account.username);
    setText('lyco-points', String(account.pointsBalance));
    setText('lyco-proxy-status', account.proxyActive
      ? ('已开通 · 有效期至 ' + (account.proxyExpiresAt ? new Date(account.proxyExpiresAt).toLocaleString('zh-CN') : '长期'))
      : '未开通代理月卡');
  }
  setText('lyco-plan-label', plan
    ? plan.name + ' · ' + plan.pointsPrice + ' 积分 / ' + plan.durationDays + ' 天'
    : '读取官方售价中…');
  el<HTMLButtonElement>('lyco-purchase').disabled = busy || !authorized || !plan || Boolean(account?.proxyActive);
  el<HTMLButtonElement>('lyco-import').disabled = busy || !authorized || !account?.proxyActive;
  el<HTMLButtonElement>('lyco-create-env').disabled = busy || !authorized || !account?.proxyActive;
  document.querySelectorAll<HTMLButtonElement>('#panel-lyco button').forEach(button => {
    if (busy) button.disabled = true;
    else if (!['lyco-import','lyco-create-env','lyco-purchase'].includes(button.id)) button.disabled = false;
  });
}
async function refresh(): Promise<void> {
  try { account = await window.api.billingAccount(); }
  catch { account = null; }
  update();
}
async function action(cb: () => Promise<unknown>, ok: string): Promise<void> {
  if (busy) return;
  busy = true; update();
  try { await cb(); toast(ok, 'success'); }
  catch (error) {
    setText('lyco-message', error instanceof Error ? error.message : String(error));
    toast(error instanceof Error ? error.message : '请求失败', 'error');
  } finally { busy = false; update(); }
}
export async function init(): Promise<void> {
  update();

  el<HTMLFormElement>('lyco-login-form').addEventListener('submit', e => {
    e.preventDefault();
    const username = el<HTMLInputElement>('lyco-input-username').value.trim();
    const passwordInput = el<HTMLInputElement>('lyco-input-password');
    const password = passwordInput.value;
    passwordInput.value = '';
    void action(async () => {
      account = await window.api.billingLogin(username, password);
      setText('lyco-message', '登录成功。浏览器不保存明文密码。');
    }, 'LYCO 账号已登录');
  });
  el('lyco-logout').addEventListener('click', () => {
    void action(async () => { await window.api.billingLogout(); account = null; }, '已退出账号');
  });
  el('lyco-refresh').addEventListener('click', () => {
    void action(async () => { account = await window.api.billingAccount(); }, '权益已刷新');
  });
  el('lyco-topup').addEventListener('click', () => {
    void action(async () => { await window.api.billingTopup(); }, '已打开官方充值页面');
  });
  el('lyco-purchase').addEventListener('click', () => {
    if (!account || !plan) return;
    const msg = '确认使用 ' + plan.pointsPrice + ' 积分购买「' + plan.name
      + '」吗？\n账号：' + account.username
      + '\n购买后会自动扣除积分，不支持直接撤销。\n\n如已经付款，请先刷新权益而不是重复购买。';
    if (!window.confirm(msg)) return;
    void action(async () => {
      await window.api.billingPurchaseProxy();
      account = await window.api.billingAccount();
      setText('lyco-message', '购买成功，可将专属代理订阅导入浏览器环境。');
    }, '代理月卡购买成功');
  });
  el('lyco-import').addEventListener('click', () => {
    void action(async () => {
      const res = await window.api.billingImportProxy();
      setText('lyco-message', res.imported
        ? '已导入 ' + res.nodeCount + ' 个节点。请转到「代理管理」选择节点，再为独立环境绑定。'
        : '代理源已经存在，共 ' + res.nodeCount + ' 个节点。');
    }, '代理节点已就绪');
  });
  el('lyco-create-env').addEventListener('click', () => {
    void action(async () => {
      const result = await window.api.billingCreateEnvironment();
      await loadEnvs();
      setText('lyco-message', '已创建「'+result.name+'」，订阅含 '+result.nodeCount+' 个节点。环境列表点击启动即可。');
      document.querySelector<HTMLButtonElement>('[aria-controls="panel-envs"]')?.click();
    }, '已创建并绑定本人订阅');
  });
  void Promise.allSettled([refresh(), (async () => {
    try {plan = await window.api.billingPlan();}
    catch (error) {setText('lyco-message', '暂无法读取在线价格：' + String(error));}
    update();
  })()]);
}
