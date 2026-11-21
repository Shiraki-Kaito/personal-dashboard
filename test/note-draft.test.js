import test from "node:test";
import assert from "node:assert/strict";
import { NoteDraft } from "../public/note-draft.js";
const source = {path:"team/note.md",commit:"a".repeat(40),text:"# 元のノート\n"};
test("編集元を変えず、下書きだけをMarkdownとして取り出す", () => {
  const draft = new NoteDraft(source);
  assert.equal(draft.dirty, false);
  draft.text += "Next Action\n<script>text only</script>";
  assert.equal(draft.dirty, true);
  assert.equal(source.text, "# 元のノート\n");
  assert.equal(draft.original, source.text);
  assert.equal(draft.filename, "note.draft.md");
  assert.equal(draft.exportText(), draft.text);
  assert.equal(draft.dirty, true); // 保存要求は保存完了ではない
  draft.markExported(draft.text);
  assert.equal(draft.dirty, false);
  draft.text += "追加";
  assert.equal(draft.dirty, true);
});
test("遅れたコピー完了で新しい変更を保存済み扱いにしない", () => {
  const draft = new NoteDraft(source);
  draft.text = "コピー開始時";
  const copied = draft.exportText();
  draft.text = "その後の編集";
  draft.markExported(copied);
  assert.equal(draft.dirty, true);
  draft.text = draft.original;
  assert.equal(draft.dirty, false);
});
test("UTF-8の上限、空本文、ローカル限定名、元の版の検証", () => {
  const draft = new NoteDraft(source);
  draft.text = "a".repeat(256 * 1024);
  assert.equal(draft.exportText().length, 256 * 1024);
  draft.text += "あ";
  assert.throws(() => draft.exportText(), /256KiB/);
  draft.text = "";
  assert.equal(draft.exportText(), "");
  for (const path of ["x_L.md", "private_L.md/x.md", "../x.md", "x.txt", "a\\x.md"])
    assert.throws(() => new NoteDraft({...source,path}));
  assert.throws(() => new NoteDraft({...source,commit:"unknown"}));
});

test("下書き比較は読み取り経路だけを使い、変更範囲とコミット差を区別する", async()=>{
  const {compareDraftSource}=await import('../public/note-draft.js');
  const origin={...source,scope:'["owner","notes","",""]'};
  const view={configured:true,config:{owner:'owner',repo:'notes',branch:'',folder:''},files:[{path:source.path,sha:'c'.repeat(40),readable:true}],commit:'b'.repeat(40),lastSuccess:new Date().toISOString()};
  const calls=[];
  const api=async input=>{calls.push(input.action);return input.action==='refresh'?view:{...source,text:'先頭\n元本文\n末尾',commit:view.commit,sha:'c'.repeat(40)};};
  const result=await compareDraftSource(origin,'先頭\n編集本文\n末尾',api);
  assert.deepEqual(calls,['refresh','read']);
  assert.equal(result.startLine,2); assert.equal(result.sourceLines,'元本文'); assert.equal(result.draftLines,'編集本文');
  assert.equal(result.sourceCommitChanged,true); assert.equal(result.same,false);
  assert.equal((await compareDraftSource(origin,'先頭\n元本文\n末尾',api)).same,true);
  for(const patch of [{stale:true},{error:'通信失敗'},{configured:false},{config:{...view.config,repo:'other'}},{files:[]}]) {
    let reads=0;
    await assert.rejects(compareDraftSource(origin,'x',async input=>{if(input.action==='read') reads++;return {...view,...patch};}));
    assert.equal(reads,0);
  }
  await assert.rejects(compareDraftSource(origin,'x',async input=>input.action==='refresh'?view:{...source,sha:'c'.repeat(40)}),/版が変わり/);
  await assert.rejects(compareDraftSource({...origin,path:'private_L.md'},'x',api));
});
