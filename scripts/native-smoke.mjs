import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.env.GITHUB_ACTIONS!=='true')throw Error('Native product acceptance only in Actions');
const output=path.resolve('native-evidence');await fs.mkdir(output,{recursive:true});
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;await new Promise(r=>server.close(r));
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES|HOMEDRIVE|HOMEPATH|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
const child=spawn(path.resolve(process.argv[2]),[`--remote-debugging-port=${port}`],{env:cleanEnv,stdio:'ignore',windowsHide:true});
let browser;const report={commit:process.env.GITHUB_SHA,checks:[],paidActions:0};
try{
 const deadline=Date.now()+45000;
 while(Date.now()<deadline){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});break}catch{await new Promise(r=>setTimeout(r,500))}}
 assert.ok(browser,'Actual packaged app must expose a live renderer for acceptance');
 const page=browser.contexts()[0].pages()[0];await page.waitForLoadState('domcontentloaded');
 await page.locator('[aria-controls="panel-lyco"]').click();
 await page.locator('#lyco-login-form').waitFor({state:'visible'});
 assert.equal(await page.locator('#lyco-input-password').getAttribute('type'),'password');
 assert.equal(await page.locator('#lyco-create-env').isDisabled(),true);
 assert.equal(await page.locator('#lyco-purchase').isDisabled(),true);
 assert.equal(await page.evaluate(()=>typeof window.api.billingCreateEnvironment),'function');
 await page.locator('#title-bar img').evaluate(img=>img.decode());
 assert.equal(await page.locator('#title-bar img').evaluate(img=>img.naturalWidth),1280);
 for(const width of [900,1200]){
  await page.setViewportSize({width,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(output,`billing-${width}.png`)});
 }
 report.checks.push('real-packaged-renderer','owned-workspace-action','anonymous-purchase-disabled','lyco-original-icon','desktop-900-1200-layout');
}catch(error){report.failure=String(error.stack||error);throw error}
finally{
 if(browser)await browser.close();child.kill();
 await fs.writeFile(path.join(output,'native-smoke.json'),JSON.stringify(report,null,2));
}
