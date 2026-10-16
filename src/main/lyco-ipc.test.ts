import {it,expect,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(event:any,...args:any[])=>unknown>());
const account=vi.hoisted(()=>vi.fn(()=>({username:'CI owner'})));
vi.mock('electron',()=>({ipcMain:{handle:(name:string,fn:any)=>handlers.set(name,fn)}}));
vi.mock('./lyco-billing',()=>({account}));
import {registerLycoBillingHandlers} from './lyco-ipc';
it('accepts only the trusted top frame for account operations',()=>{
 const frame={},window={mainFrame:frame};
 registerLycoBillingHandlers(()=>window as any);
 const read=handlers.get('billing:account')!;
 expect(()=>read({sender:{mainFrame:frame},senderFrame:frame})).toThrow('主窗口');
 expect(()=>read({sender:window,senderFrame:{}})).toThrow('主窗口');
 expect(account).not.toHaveBeenCalled();
 expect(read({sender:window,senderFrame:frame})).toEqual({username:'CI owner'});
});
