import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyPriorityRules,
  normalizePriorityRules,
  priorityWithRules,
  previewPriorityRules,
  savePriorityRules,
  priorityRulesView,
} from "../src/mail-priority-rules.js";
import { agendaHome } from "../src/agenda-home.js";
import { agendaView } from "../src/agenda.js";
import {
  createAgendaBackup,
  agendaRestoreEntries,
} from "../src/agenda-backup.js";
import { digest } from "../src/agenda-rules.js";
import {
  previewAccountDeletion,
  deleteAccount,
  disconnectAccount,
  clearAccountCache,
} from "../src/agenda-management.js";
import { createBackup, backupPlan } from "../src/backup.js";

function memory(entries = []) {
  const values = new Map(entries);
  const s = {
    values,
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
    list: async ({ prefix }) =>
      new Map([...values].filter(([k]) => k.startsWith(prefix))),
    transaction: async (fn) => fn(s),
  };
  return s;
}
const rule = (values) =>
  normalizePriorityRules({ ...emptyPriorityRules(), ...values });
test("設定の上限・形式を検証し、全角と大文字を統一する", () => {
  assert.deepEqual(
    rule({ priorityKeywords: [" ＥＳ ", "es"] }).priorityKeywords,
    ["es"],
  );
  for (const values of [
    { prioritySenders: ["bad"] },
    { excludedSenders: ["a@example.com\nother@example.com"] },
    { priorityKeywords: Array(21).fill("a") },
    { priorityKeywords: ["a".repeat(101)] },
    { excludedKeywords: [""] },
  ])
    assert.throws(() => rule(values));
  assert.throws(() =>
    normalizePriorityRules({ ...emptyPriorityRules(), unknown: [] }),
  );
});
test("アドレスとドメインを正確に照合し、除外を優先する。語句は正規表現にしない", () => {
  const rules = rule({
    prioritySenders: ["@example.ac.jp"],
    excludedKeywords: ["セミナー"],
  });
  assert.equal(
    priorityWithRules(
      { subject: "お知らせ", from: "事務 <office@example.ac.jp>" },
      rules,
    ).important,
    true,
  );
  for (const from of [
    "office@evil-example.ac.jp",
    "office@sub.example.ac.jp",
    "office@example.ac.jp <actual@evil.test>",
  ])
    assert.equal(
      priorityWithRules({ subject: "お知らせ", from }, rules).important,
      false,
    );
  assert.equal(
    priorityWithRules(
      { subject: "セミナー", from: "office@example.ac.jp" },
      rules,
    ).important,
    false,
  );
  const literal = rule({ priorityKeywords: [".*"] });
  assert.equal(
    priorityWithRules({ subject: "普通のお知らせ" }, literal).important,
    false,
  );
  assert.equal(
    priorityWithRules({ subject: "文字列 .* のお知らせ" }, literal).important,
    true,
  );
});
async function setup() {
  const id = await digest("fixture@example.test"),
    other = await digest("other@example.test");
  const s = memory([
    [
      "agenda:accounts",
      [
        { id, email: "fixture@example.test", calendar: "primary" },
        { id: other, email: "other@example.test", calendar: "primary" },
      ],
    ],
    [
      "agenda:credential:" + id,
      { token: "private-fixture", expires: Date.now() + 3600000 },
    ],
    [
      "agenda:cache:" + id,
      {
        messages: [
          {
            id: "aaa",
            subject: "運営連絡",
            from: "team@example.test",
            excerpt: "会場の情報",
            receivedAt: new Date().toISOString(),
            candidate: {
              title: "会議",
              start: "",
              end: "",
              location: "",
              reasons: [],
              status: "候補なし",
              isCandidate: false,
            },
          },
        ],
        lastSuccess: new Date().toISOString(),
      },
    ],
  ]);
  return { s, id, other };
}
test("影響確認は保存せず、接続別に保存・復旧し、古い画面や確認不足を拒否する", async () => {
  const { s, id, other } = await setup();
  const rules = rule({ priorityKeywords: ["運営連絡"] });
  const before = structuredClone(s.values);
  const preview = await previewPriorityRules(s, { accountId: id, rules });
  assert.equal(preview.important, 1);
  assert.equal(preview.changedCount, 1);
  assert.deepEqual(s.values, before);
  await assert.rejects(
    savePriorityRules(s, { accountId: id, rules, revision: null }),
  );
  const saved = await savePriorityRules(s, {
    accountId: id,
    rules,
    revision: null,
    confirm: true,
  });
  assert.ok(saved.revision);
  assert.equal((await priorityRulesView(s, other)).revision, null);
  await assert.rejects(
    savePriorityRules(s, {
      accountId: id,
      rules,
      revision: null,
      confirm: true,
    }),
    /別の画面/,
  );
  await assert.rejects(
    savePriorityRules(s, {
      accountId: "unknown",
      rules,
      revision: null,
      confirm: true,
    }),
  );
  assert.deepEqual(await priorityRulesView(memory([...s.values]), id), saved);
  const reset = await savePriorityRules(s, {
    accountId: id,
    rules: emptyPriorityRules(),
    revision: saved.revision,
    confirm: true,
  });
  assert.deepEqual(reset.rules, emptyPriorityRules());
});
test("ホームと全件一覧へ即反映し、除外してもメールと未確認の登録結果を消さない", async () => {
  const { s, id } = await setup();
  await savePriorityRules(s, {
    accountId: id,
    rules: rule({ priorityKeywords: ["運営連絡"] }),
    revision: null,
    confirm: true,
  });
  assert.equal((await agendaHome(s)).candidates, 1);
  assert.equal(
    (await agendaView({}, s, id)).messages[0].priority.important,
    true,
  );
  const revision = (await priorityRulesView(s, id)).revision;
  await savePriorityRules(s, {
    accountId: id,
    rules: rule({ excludedSenders: ["team@example.test"] }),
    revision,
    confirm: true,
  });
  await s.put("agenda:pending:" + id, ["aaa"]);
  await s.put("agenda:operation:" + id + ":aaa", {
    draft: { title: "試験予定" },
    phase: "登録結果未確認",
  });
  const home = await agendaHome(s);
  assert.equal(home.pending, 1);
  assert.equal(home.candidates, 0);
  assert.equal((await agendaView({}, s, id)).messages.length, 1);
});
test("バックアップに設定を含め、空の保存先へ復元し既存設定の上書きを止める", async () => {
  const { s, id } = await setup();
  const saved = await savePriorityRules(s, {
    accountId: id,
    rules: rule({ priorityKeywords: ["運営"] }),
    revision: null,
    confirm: true,
  });
  const backup = await createAgendaBackup(s);
  assert.deepEqual(backup[0].priorityRules, saved.rules);
  assert.equal(JSON.stringify(backup).includes("private-fixture"), false);
  const target = memory([["agenda:accounts", await s.get("agenda:accounts")]]);
  const restored = await agendaRestoreEntries(target, backup);
  assert.deepEqual(
    restored.entries.get("agenda:priorityRules:" + id).rules,
    saved.rules,
  );
  assert.notEqual(
    restored.entries.get("agenda:priorityRules:" + id).revision,
    saved.revision,
  );
  await target.put("agenda:priorityRules:" + id, saved);
  const wrapped = await createBackup(
    { PROJECT_CONFIG: JSON.stringify({ projects: [] }) },
    s,
  );
  const plan = await backupPlan(
    { PROJECT_CONFIG: JSON.stringify({ projects: [] }) },
    target,
    wrapped,
  );
  assert.ok(plan.conflicts.includes("agenda:priorityRules:" + id));
  const bad = structuredClone(backup);
  bad[0].priorityRules.priorityKeywords = ["x".repeat(101)];
  await assert.rejects(agendaRestoreEntries(target, bad));
});

test("停止とキャッシュ整理では保持し、完全削除では対象設定だけを除く", async () => {
  const { s, id, other } = await setup();
  const saved = await savePriorityRules(s, {
    accountId: id,
    rules: rule({ priorityKeywords: ["運営"] }),
    revision: null,
    confirm: true,
  });
  const otherRules = await savePriorityRules(s, {
    accountId: other,
    rules: rule({ priorityKeywords: ["学校"] }),
    revision: null,
    confirm: true,
  });
  await disconnectAccount(s, { accountId: id, confirm: true });
  assert.deepEqual(await priorityRulesView(s, id), saved);
  await clearAccountCache(s, { accountId: id, confirm: true });
  assert.deepEqual(await priorityRulesView(s, id), saved);
  const plan = await previewAccountDeletion(s, { accountId: id });
  await deleteAccount(s, {
    accountId: id,
    email: "fixture@example.test",
    confirm: true,
    checksum: plan.checksum,
  });
  assert.equal(await s.get("agenda:priorityRules:" + id), undefined);
  assert.deepEqual(await priorityRulesView(s, other), otherRules);
});

test("本文後半のカスタム優先・除外語句と6000文字境界を判定する",()=>{
  const base={subject:'連絡',excerpt:'a'.repeat(1600),bodyCoverage:'complete'};
  const rules=rule({priorityKeywords:['参加証'],excludedKeywords:['対象外']});
  assert.equal(priorityWithRules({...base,timingText:'a'.repeat(5997)+'参加証'},rules).important,true);
  assert.equal(priorityWithRules({...base,timingText:'a'.repeat(6000)+'参加証'},rules).important,false);
  assert.equal(priorityWithRules({...base,timingText:'a'.repeat(2000)+'参加証 対象外'},rules).important,false);
  assert.equal(priorityWithRules({...base,timingText:'a'.repeat(2000)+'参加証 対象外',keepBody:true},rules).important,true);
  assert.equal(priorityWithRules({...base,timingText:'a'.repeat(2000)+'ＥＳ'},rule({priorityKeywords:['es']})).important,true);
});

test("追加本文の語句による重要判定をホーム・一覧・プレビューで揃え、本文は一覧APIへ追加配布しない",async()=>{
  const {s,id}=await setup();
  const cache=await s.get('agenda:cache:'+id);
  cache.messages[0]={...cache.messages[0],subject:'連絡',excerpt:'a'.repeat(1600),timingText:'a'.repeat(2000)+'運営連絡',bodyCoverage:'complete'};
  await s.put('agenda:cache:'+id,cache);
  const rules=rule({priorityKeywords:['運営連絡']});
  await savePriorityRules(s,{accountId:id,rules,revision:null,confirm:true});
  assert.equal((await previewPriorityRules(s,{accountId:id,rules})).important,1);
  assert.equal((await agendaHome(s)).candidates,1);
  const view=await agendaView({},s,id);
  assert.equal(view.messages[0].priority.important,true);
  assert.equal(view.messages[0].timingText,undefined);
  const excluded=rule({priorityKeywords:['運営連絡'],excludedKeywords:['運営連絡']});
  await savePriorityRules(s,{accountId:id,rules:excluded,revision:(await priorityRulesView(s,id)).revision,confirm:true});
  assert.equal((await agendaView({},s,id)).messages[0].priority.important,false);
  assert.equal((await agendaHome(s)).candidates,0);
});
