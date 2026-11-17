import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewSummary} from '../public/overview-summary.js';
test('概要は未対応・登録未確認だけを数え、全件を変更せず2件に絞る',()=>{
 const state={tasks:[{category:'other',title:'除外'},{category:'priority',title:'確認'}],agenda:{accounts:[{}],groups:[{label:'対応済',caseState:{status:'done'}},{label:'保留',caseState:{status:'hold'}},{label:'結果未確認',pending:true,caseState:{status:'done'}},...['A','B','C'].map(label=>({label}))],caseHistory:[{label:'一覧外',status:'open'}]},calendar:{events:[]}};
 const before=structuredClone(state), result=overviewSummary(state);
 assert.equal(result.mail.count,5); assert.deepEqual(result.mail.lines,['結果未確認','A']);assert.deepEqual(result.tasks.lines,['確認']);assert.deepEqual(state,before);
});
test('終了した予定を除き、終日と日本時間を表示する',()=>{
 const events=[{title:'終了',start:{date:'2026-11-15'},end:{date:'2026-11-16'},allDay:true},{title:'終日',start:{date:'2026-11-17'},end:{date:'2026-11-18'},allDay:true},{title:'面談',start:{dateTime:'2026-11-17T10:00:00+09:00'},end:{dateTime:'2026-11-17T11:00:00+09:00'}}];
 const result=overviewSummary({calendar:{events,complete:true}},Date.parse('2026-11-17T00:00:00+09:00'));
 assert.equal(result.calendar.count,2);assert.match(result.calendar.lines[0],/2026-11-17・終日/);assert.match(result.calendar.lines[1],/10:00/);
});
test('空の情報を正常・接続済みと扱わず、取得状況へ誘導する',()=>{
 const result=overviewSummary({});assert.match(result.tasks.hint,/取得状況/);assert.match(result.calendar.hint,/取得状況/);assert.equal(result.mail.hint,'メールは未接続');assert.match(result.drive.hint,/取得状況/);
});
