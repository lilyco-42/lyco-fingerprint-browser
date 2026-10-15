import { ipcMain } from 'electron';
import * as billing from './lyco-billing';

export function registerLycoBillingHandlers(): void {
  ipcMain.handle('billing:login', (_event, username: string, password: string) =>
    billing.login(username, password));
  ipcMain.handle('billing:logout', () => billing.logout());
  ipcMain.handle('billing:account', () => billing.account());
  ipcMain.handle('billing:plan', () => billing.plan());
  ipcMain.handle('billing:topup', () => billing.topup());
  ipcMain.handle('billing:purchaseProxy', () => billing.purchaseProxy());
  ipcMain.handle('billing:importProxy', () => billing.importProxy());
}
