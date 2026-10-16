import {describe,it,expect,vi} from 'vitest';
import http from 'node:http';
vi.mock('./store',()=>({newId:()=> 'ci-node'}));
vi.mock('./mihomo-manager',()=>({saveSubscriptionBackup:vi.fn()}));
import {fetchSubscription} from './subscription';

describe('actual subscription HTTP transport and JSON/Clash parser',()=>{
 it('accepts the backend Clash JSON shape and rejects HTTP failures and oversized bodies',async()=>{
  const server=http.createServer((req,res)=>{
   if(req.url==='/missing'){res.writeHead(404);res.end('not found');return;}
   if(req.url==='/large'){res.end('x'.repeat(2_000_001));return;}
   if(req.url==='/bad-redirect'){res.writeHead(302,{Location:'file:///etc/passwd'});res.end();return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({proxies:[{name:'CI node',type:'http',server:'127.0.0.1',port:8000}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number},base='http://127.0.0.1:'+address.port;
  try{
   expect(await fetchSubscription(base+'/clash','owned')).toMatchObject([{sourceId:'owned',name:'CI node',type:'http',port:8000}]);
   await expect(fetchSubscription(base+'/missing','owned')).rejects.toThrow('HTTP 404');
   await expect(fetchSubscription(base+'/large','owned')).rejects.toThrow('过大');
   await expect(fetchSubscription(base+'/bad-redirect','owned')).rejects.toThrow('HTTP 或 HTTPS');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});
