// ローカル専用。GitHub CLIにGraphQLを渡し、CLIの資格情報は取得しない。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { github } from "../src/github.js";
import { same, synchronize } from "../src/sync.js";
const [configFile, journalFile] = process.argv.slice(2);
if (!configFile || !journalFile)
  throw Error("ローカル設定ファイルと新規の復元記録パスが必要です");
const config = JSON.parse(readFileSync(configFile, "utf8"));
assert.equal(config.owner, "Shiraki-Kaito");
assert.equal(config.url, "https://github.com/users/Shiraki-Kaito/projects/1");
const request = async (query, variables) =>
  JSON.parse(
    execFileSync("gh", ["api", "graphql", "--input", "-"], {
      encoding: "utf8",
      input: JSON.stringify({ query, variables }),
      timeout: 20000,
      stdio: ["pipe", "pipe", "ignore"],
    }),
  ).data;
const api = github(config, request);
const values = new Map();
const storage = {
  get: (k) => structuredClone(values.get(k)),
  put: (k, v) => values.set(k, structuredClone(v)),
};
const sync = (action, input = {}) =>
  synchronize(action, input, config, api, storage);
const before = (await sync("refresh")).remote;
assert.ok(before);
const journal = { before, lastConfirmed: before };
writeFileSync(journalFile, JSON.stringify(journal), { flag: "wx" });
function record(snapshot) {
  journal.lastConfirmed = snapshot;
  writeFileSync(journalFile, JSON.stringify(journal));
}
async function checked() {
  const live = await api.read();
  assert.ok(
    same(live, journal.lastConfirmed),
    "外部変更・結果不明のため上書きを停止。復元記録を確認してください",
  );
  return live;
}
async function change(field, value, source) {
  const base = await checked();
  let after;
  if (source === "dashboard") {
    const s = await sync("edit", { field, value, base });
    assert.equal(s.pending, null);
    after = s.remote;
  } else {
    await api.write(field, value);
    after = await api.read();
  }
  assert.equal(after[field], value);
  const other = field === "due" ? "status" : "due";
  assert.equal(after[other], base[other]);
  assert.ok(same(after, await api.read()));
  record(after);
}
try {
  const status = config.options.find((o) => o.id !== before.status).id;
  await change("status", status, "dashboard");
  console.log("アプリ→GitHub: 状態変更と独立再取得が一致");
  await change(
    "due",
    before.due === "2030-01-15" ? "2030-01-16" : "2030-01-15",
    "dashboard",
  );
  await change("due", null, "dashboard");
  console.log("アプリ→GitHub: 期限設定・解除が一致");
  const stale = journal.lastConfirmed;
  await change("due", "2030-01-17", "github");
  const conflict = await sync("edit", {
    base: stale,
    field: "due",
    value: "2030-01-18",
  });
  assert.match(conflict.phase, /競合/);
  await checked();
  const refreshed = await sync("discard", { id: conflict.pending.id });
  assert.equal(refreshed.remote.due, "2030-01-17");
  console.log("GitHub→アプリ: 外部変更を取得、古い編集を競合として停止");
} finally {
  await checked();
  for (const field of ["due", "status"]) {
    if (journal.lastConfirmed[field] !== before[field])
      await change(field, before[field], "github");
  }
  const final = await api.read();
  assert.equal(final.status, before.status);
  assert.equal(final.due, before.due);
  console.log("実GitHubで開始時の状態・期限への復元を確認");
}
