import test from 'node:test';
import assert from 'node:assert/strict';
import {recordMonitorSignal,observeResponse,monitoringView,deliverSecurityAlert} from '../src/security-monitor.js';
const hour=3_600_000;
function fixture(){const data=new Map();return {get:async key=>structuredClone(data.get(key)),put:async(key,value)=>data.set(key,structuredClone(value))};}
const configured = send => ({SECURITY_ALERTS_ENABLED:'true',SECURITY_ALERT_FROM:'alert@example.com',SECURITY_ALERT_TO:'owner@example.net',SECURITY_EMAIL:{send}});

test('閾値と時間窓、同種の24時間抑制、送信未設定、7日削除を区別する',async()=>{
  const storage=fixture();
  for(let i=0;i<19;i++)await observeResponse(storage,'/api/drive?secret=never',403,'GET',i);
  assert.equal((await monitoringView({},storage,20)).alerts.length,0);
  await observeResponse(storage,'/api/drive',403,'GET',20);
  for(let i=0;i<100;i++)await observeResponse(storage,'/api/drive',403,'GET',21+i);
  const view=await monitoringView({},storage,121);
  assert.equal(view.configured,false); assert.equal(view.alerts.length,1);
  assert.equal(JSON.stringify(view).includes('never'),false);
  await deliverSecurityAlert({},storage,121);
  assert.equal((await monitoringView({},storage,121)).alerts[0].attempts,0);
  await deliverSecurityAlert({},storage,8*24*hour);
  assert.equal((await storage.get('security:monitor')).alerts.length,0);
  for(let i=0;i<19;i++)await recordMonitorSignal(storage,'denied',8*24*hour);
  await recordMonitorSignal(storage,'denied',8*24*hour+300_000);
  assert.equal((await monitoringView({},storage,8*24*hour+300_000)).alerts.length,0);
});
test('サービス受付と実到達を区別し、再起動後に同じ通知を送らない',async()=>{
  const storage=fixture();let sends=0;
  await recordMonitorSignal(storage,'test',0);
  const env=configured(async message=>{sends++;assert.equal(message.to,'owner@example.net');return {messageId:'provider-id'};});
  await deliverSecurityAlert(env,storage,1);
  await deliverSecurityAlert(env,storage,hour);
  assert.equal(sends,1);assert.equal((await monitoringView(env,storage,hour)).alerts[0].status,'accepted');
  assert.equal(JSON.stringify(await storage.get('security:monitor')).includes('owner@example.net'),false);
});
test('応答消失・未知の送信エラーは結果不明で停止し秘密を保存しない',async()=>{
  const storage=fixture();let sends=0;
  await recordMonitorSignal(storage,'test',0);
  const env=configured(async()=>{sends++;throw Error('secret-value');});
  await deliverSecurityAlert(env,storage,1);await deliverSecurityAlert(env,storage,24*hour);
  const state=await storage.get('security:monitor');
  assert.equal(sends,1);assert.equal(state.alerts[0].status,'unknown');assert.equal(JSON.stringify(state).includes('secret-value'),false);
});
test('受付前の明示拒否だけ待機付き3回まで再試行する',async()=>{
  const storage=fixture();let sends=0;
  await recordMonitorSignal(storage,'test',0);
  const env=configured(async()=>{sends++;throw Object.assign(Error('rate'),{code:'E_RATE_LIMIT_EXCEEDED'});});
  await deliverSecurityAlert(env,storage,0);await deliverSecurityAlert(env,storage,1);
  assert.equal(sends,1);
  await deliverSecurityAlert(env,storage,hour);await deliverSecurityAlert(env,storage,3*hour);await deliverSecurityAlert(env,storage,7*hour);
  assert.equal(sends,3);assert.equal((await monitoringView(env,storage,7*hour)).alerts[0].status,'failed');
});
test('送信前の永続化失敗と不正な宛先設定は送信しない',async()=>{
  const storage=fixture();let sends=0;
  await recordMonitorSignal(storage,'test',0);
  const env=configured(async()=>{sends++;return {messageId:'id'};});
  await deliverSecurityAlert({...env,SECURITY_ALERT_TO:'owner@example.net\r\nBcc: other@example.net'},storage,0);
  let writes=0;const broken={get:storage.get,put:async(...args)=>{if(++writes===2)throw Error('disk');return storage.put(...args)}};
  await assert.rejects(deliverSecurityAlert(env,broken,0));assert.equal(sends,0);
});
