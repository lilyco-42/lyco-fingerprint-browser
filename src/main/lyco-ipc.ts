import { ipcMain, type WebContents } from 'electron';
import * as billing from './lyco-billing';

export function registerLycoBillingHandlers(trusted: () => WebContents | undefined): void {
  const handle = (channel: string, listener: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== trusted() || event.senderFrame !== event.sender.mainFrame)
        throw new Error('仅允许本应用的主窗口操作账户');
      return listener(event, ...args);
    });
  };
  handle('billing:login', (_event, username: string, password: string) =>
    billing.login(username, password));
  handle('billing:logout', () => billing.logout());
  handle('billing:account', () => billing.account());
  handle('billing:plan', () => billing.plan());
  handle('billing:topup', () => billing.topup());
  handle('billing:purchaseProxy', () => billing.purchaseProxy());
  handle('billing:importProxy', () => billing.importProxy());
  handle('billing:createEnvironment', () => billing.createOwnedEnvironment());
  handle('billing:copyExtension', (_event, id: string) => billing.copyExtensionConnection(id));
}
