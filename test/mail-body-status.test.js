import test from 'node:test';
import assert from 'node:assert/strict';
import { mailBodySummary } from '../src/mail-body-coverage.js';
import { agendaHome } from '../src/agenda-home.js';

test('追加本文を取得済みの場合は部分取得と分類しない', () => {
  const result = mailBodySummary([{bodyCoverage:'complete',contentLimited:true,timingText:'本文'}]);
  assert.equal(result.extended,1);
  assert.equal(result.partial,0);
  assert.match(result.notice,/追加本文を使用/);
  assert.doesNotMatch(result.notice,/範囲が一部/);
});

test('本文未取得・容量制限・部分取得・旧抜粋を区別する', () => {
  const result = mailBodySummary([
    {bodyCoverage:'unavailable'}, {bodyCoverage:'capacity'}, {bodyCoverage:'partial'},
    {excerpt:'a'.repeat(1600)}, {bodyCoverage:'complete',excerpt:'short'}
  ]);
  for(const key of ['unavailable','capacity','partial','legacy']) assert.equal(result[key],1);
  assert.equal(result.extended,0);
  assert.match(result.notice,/容量上限/);
});

async function homeWith({coverage='complete',old=false,error=null,disconnected=false}={}) {
  const now=Date.now();
  const records = new Map([
    ['agenda:accounts',[{id:'a',email:'a@example.test',...(disconnected?{disconnectedAt:new Date(now).toISOString()}:{})}]],
    ['agenda:credential:a',{token:'fixture',refresh:'fixture',expires:now+3600000}],
    ['agenda:cache:a',{lastSuccess:new Date(now-(old?7200000:0)).toISOString(),error,messages:[
      {id:'one',subject:'test',bodyCoverage:coverage,contentLimited:true,...(coverage==='complete'?{timingText:'body'}:{}),candidate:{isCandidate:false}}
    ]}]
  ]);
  return agendaHome({get:async key=>structuredClone(records.get(key))},now);
}

test('本文の仕様上の制限は接続警告にせず案内を保持する',async()=>{
  for(const coverage of ['complete','partial','capacity']) {
    const view=await homeWith({coverage});
    assert.ok(!view.alerts.some(item=>/本文/.test(item.message)));
    assert.equal(view.notices.length,1);
    assert.equal(view.complete,false); // 分類範囲の制限を「全確認済み」に変えない。
  }
});

test('古さ・取得失敗・本文未取得の警告は解析範囲の案内で隠さない',async()=>{
  assert.ok((await homeWith({old:true})).alerts.some(item=>/1時間以上/.test(item.message)));
  assert.ok((await homeWith({error:'取得失敗'})).alerts.some(item=>/取得失敗/.test(item.message)));
  assert.ok((await homeWith({coverage:'unavailable'})).alerts.some(item=>/本文を取得できていない/.test(item.message)));
  const disconnected=await homeWith({coverage:'partial',disconnected:true});
  assert.deepEqual(disconnected.alerts,[]);
  assert.deepEqual(disconnected.notices,[]);
});
