import test from "node:test";
import assert from "node:assert/strict";
import {
  mailPriority,
  currentMailPriority,
  mailPriorityVersion,
} from "../src/agenda-priority.js";
import { agendaHome } from "../src/agenda-home.js";
import { agendaView } from "../src/agenda.js";

test("対策セミナー・一般募集・キャリア広告を重要から外し、個別の手続は残す", () => {
  for (const subject of [
    "面接・ES対策セミナーのお知らせ",
    "明日締切！インターンシップ エントリー受付中",
    "キャリアアドバイザーとの面談実施中",
    "理系の職種選び・自分に合う面談",
    "選択肢を整理する面談のご紹介",
    "人事課題にどう向き合うか",
  ])
    assert.equal(
      mailPriority({ subject }, "面談や課題、提出に役立つ情報です").important,
      false,
      subject,
    );
  for (const subject of [
    "一次面接の日程確定",
    "成績証明書ご提出のお願い",
    "選考結果のご連絡",
    "エントリーシートのご提出ありがとうございます",
    "面接対策セミナー予約完了",
    "就活準備の面談 日程調整",
    "履修登録の提出締切",
    "課題の提出について",
  ])
    assert.equal(
      mailPriority({ subject }, "配信停止はこちら").important,
      true,
      subject,
    );
  assert.equal(
    mailPriority(
      { subject: "面談日程確定", from: "noreply@example.test" },
      "メルマガ配信停止",
    ).important,
    true,
  );
  assert.equal(
    mailPriority({ subject: "人事課題にどう向き合うか" }).category,
    "other",
  );
});

test("旧キャッシュは追加取得せず再判定し、現行の全文判定は失わない", () => {
  const old = {
    subject: "面接対策セミナー",
    excerpt: "選考対策です",
    priority: { important: true, category: "career", reason: "old" },
  };
  assert.equal(currentMailPriority(old).important, false);
  assert.equal(old.priority.important, true);
  const full = mailPriority(
    { subject: "大学のお知らせ", from: "office@example.ac.jp" },
    "x".repeat(1700) + "課題提出の締切です",
  );
  assert.equal(full.important, true);
  const message = {
    subject: "大学のお知らせ",
    excerpt: "x".repeat(1600),
    priority: full,
  };
  assert.deepEqual(currentMailPriority(message), full);
  assert.equal(full.version, mailPriorityVersion);
});

test("ホームと全件一覧に同じ新判定を適用し、その他のメールも確認記録も保持する", async () => {
  const values = new Map([
    ["agenda:accounts", [{ id: "a", email: "fixture@example.test" }]],
    [
      "agenda:credential:a",
      { token: "fixture", expires: Date.now() + 3600000 },
    ],
    ["agenda:reviews:a", { ccc: { reviewedAt: new Date().toISOString() } }],
    [
      "agenda:cache:a",
      {
        lastSuccess: new Date().toISOString(),
        messages: [
          {
            id: "aaa",
            subject: "面接対策セミナー",
            candidate: { isCandidate: true },
            priority: { important: true, category: "career", reason: "old" },
          },
          {
            id: "bbb",
            subject: "成績証明書ご提出のお願い",
            candidate: { isCandidate: true },
          },
          {
            id: "ccc",
            subject: "面談日程確定",
            candidate: { isCandidate: true },
          },
        ],
      },
    ],
  ]);
  const storage = { get: async (key) => structuredClone(values.get(key)) };
  const home = await agendaHome(storage);
  assert.deepEqual(
    home.entries.map((entry) => entry.messageId),
    ["bbb"],
  );
  const view = await agendaView({}, storage, "a");
  assert.equal(view.messages.length, 3);
  assert.equal(view.messages[0].priority.important, false);
  assert.equal(view.messages[1].priority.important, true);
  assert.ok(view.messages[2].review);
  assert.equal(
    values.get("agenda:cache:a").messages[0].priority.important,
    true,
  );
});

test("本文後半の対応依頼を重要判定し、宣伝・引用・上限外からは推測しない",()=>{
  const late="連絡事項\n".repeat(500)+"\n提出期限：2026/12/15 17:00";
  assert.equal(mailPriority({subject:"採用に関するご連絡"},late).important,true);
  assert.equal(mailPriority({subject:"事務からのお知らせ",from:"office@example.ac.jp"},late).important,true);
  assert.equal(mailPriority({subject:"採用ニュース・セミナー募集中"},late).important,false);
  assert.equal(mailPriority({subject:"採用に関するご連絡"},"x".repeat(6000)+"提出期限").important,false);
  assert.equal(mailPriority({subject:"採用に関するご連絡"},"連絡事項\n".repeat(500)+"\n-----Original Message-----\n提出期限").important,false);
});

test("旧版の重要判定は抜粋不足で降格せず、保存済み追加本文は新判定で使う",()=>{
  const previous={subject:"採用に関するご連絡",excerpt:"連絡",priority:{version:2,important:true,category:"career",reason:"前回"}};
  assert.equal(currentMailPriority(previous).important,true);
  assert.match(currentMailPriority(previous).reason,/前回の重要判定/);
  assert.equal(currentMailPriority({...previous,priority:{...previous.priority,important:false},timingText:"連絡\n".repeat(1000)+"提出期限"}).important,true);
});
