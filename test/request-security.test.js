import test from 'node:test';
import assert from 'node:assert/strict';
import {readRequestJson,allowRequest} from '../src/request-security.js';
const request = body => new Request('https://unit.test',{method:'POST',body,duplex:'half'});
test('受信サイズを宣言値に依存せず制限し、UTF8・JSON・タイムアウトを拒否する',async()=>{
 assert.deepEqual(await readRequestJson(request('{"名":"日本語"}'),100),{名:'日本語'});
 assert.deepEqual(await readRequestJson(request('{}'),2),{});
 await assert.rejects(readRequestJson(request('{}'),1),e=>e.status===413);
 await assert.rejects(readRequestJson(request('[]')),e=>e.status===400);
 await assert.rejects(readRequestJson(request(new Uint8Array([255]))),e=>e.status===400);
 await assert.rejects(readRequestJson(new Request('https://unit.test',{method:'POST',body:'{}',headers:{'content-length':'999'}}),3),e=>e.status===413);
 const stalled = new ReadableStream({start(){},cancel(){}});
 await assert.rejects(readRequestJson(request(stalled),10,10),e=>e.status===408);
});
test('共有の試行制限は上限で拒否し、時間経過で回復、保存障害は許可しない',async()=>{
 const data=new Map(),storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)};
 assert.equal(await allowRequest(storage,'login',2,0),true);
 assert.equal(await allowRequest(storage,'login',2,1),true);
 assert.equal(await allowRequest(storage,'login',2,2),false);
 assert.equal(await allowRequest(storage,'login',2,60000),true);
 await assert.rejects(allowRequest({get:async()=>{throw Error('unavailable')}},'login',2));
});

test('監査記録は7日・100件に制限し秘密値を記録しない',async()=>{
 const {recordSecurityEvent}=await import('../src/request-security.js');
 const data=new Map(),storage={get:async k=>data.get(k),put:async(k,v)=>data.set(k,v)};
 for(let i=0;i<105;i++)await recordSecurityEvent(storage,{route:'drive',method:'POST',status:403,token:'never-store'},i);
 assert.equal(data.get('security:audit').length,100);
 assert.equal(JSON.stringify(data.get('security:audit')).includes('never-store'),false);
 await recordSecurityEvent(storage,{route:'drive',method:'POST',status:200},8*24*60*60*1000);
 assert.equal(data.get('security:audit').length,1);
});

test('ログイン制限は送信元を分離し、偽Forwardedでは迂回できない',async()=>{
 const {allowLoginRequest}=await import('../src/request-security.js');
 const data=new Map(),storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,v)};
 const req=(ip,forwarded)=>new Request('https://unit.test/auth/login',{headers:{'CF-Connecting-IP':ip,'X-Forwarded-For':forwarded}});
 for(let i=0;i<5;i++)assert.equal(await allowLoginRequest(req('192.0.2.1',String(i)),storage,0),true);
 assert.equal(await allowLoginRequest(req('192.0.2.1','new'),storage,1),false);
 assert.equal(await allowLoginRequest(req('192.0.2.2','new'),storage,1),true);
 assert.equal(await allowLoginRequest(req('192.0.2.1','new'),storage,60000),true);
 assert.equal(JSON.stringify([...data.values()]).includes('192.0.2.'),false);
});
