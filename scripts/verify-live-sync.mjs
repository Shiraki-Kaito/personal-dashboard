// 明示実行専用。実GitHubと本体ロジックを使い、障害はこのローカル検証内だけに注入する。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { github, RemoteError } from "../src/github.js";
import { synchronize, same } from "../src/sync.js";

const [configPath, outputPath] = process.argv.slice(2);
assert.ok(
  configPath && outputPath,
  "引数: ローカルconfig.json 記録用の新規フォルダ",
);
const config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.url, "https://github.com/users/Shiraki-Kaito/projects/1");
assert.notEqual(config.mode, "production", "実運用設定では実行できません");
config.mode = "test";
const output = path.resolve(outputPath);
const relativeOutput = path.relative(
  fileURLToPath(new URL("..", import.meta.url)),
  output,
);
assert.ok(
  relativeOutput.startsWith(".." + path.sep) || path.isAbsolute(relativeOutput),
  "記録はリポジトリ外へ保存してください",
);
await mkdir(output, { recursive: false });
const request = async (query, variables) => {
  let result;
  try {
    result = JSON.parse(
      execFileSync("gh", ["api", "graphql", "--input", "-"], {
        input: JSON.stringify({ query, variables }),
        encoding: "utf8",
        timeout: 25000,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      }),
    );
  } catch {
    throw new RemoteError(
      "検証CLIのAPI要求に失敗しました。記録を確認してください",
    );
  }
  if (result.errors || !result.data)
    throw new RemoteError("GitHubが検証API要求を拒否しました");
  return result.data;
};
const real = github(config, request);
const before = await real.read(); // 本体で試験Project名・試験タスク名・本人IDを検証。
let expected = before,
  writes = 0,
  fault = null;
const journal = { before, lastConfirmed: before, cases: [], completed: false };
const saveJournal = () =>
  writeFile(
    path.join(output, "journal.json"),
    JSON.stringify(journal, null, 2),
  );
await saveJournal();
async function guardedWrite(field, value) {
  const current = await real.read();
  assert.ok(same(current, expected), "外部変更を検知。更新・復元を停止します");
  journal.intent = { field, value, base: current };
  await saveJournal();
  await real.write(field, value);
  writes++;
  const after = await real.read();
  assert.equal(after[field], value, "書き込み結果不明。復元を停止します");
  const other = field === "due" ? "status" : "due";
  assert.equal(
    after[other],
    current[other],
    "外部変更を検知。復元を停止します",
  );
  expected = after;
  journal.lastConfirmed = after;
  delete journal.intent;
  await saveJournal();
}
const api = {
  read: async () => {
    if (fault === "network") throw new RemoteError("通信失敗（検証注入）");
    return real.read();
  },
  write: async (field, value) => {
    if (fault === "permission") throw new RemoteError("権限不足（検証注入）");
    await guardedWrite(field, value);
    if (fault === "lost-response")
      throw new RemoteError("応答喪失（検証注入）");
  },
};
const statePath = path.join(output, "state.json");
let storage = {
  get: async () => {
    try {
      return JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  },
  put: async (_, value) => writeFile(statePath, JSON.stringify(value, null, 2)),
};
const call = (action, input = {}) =>
  synchronize(action, input, config, api, storage);
const edit = async (field, value) =>
  call("edit", { field, value, base: (await call("state")).remote });
const record = async (name) => {
  journal.cases.push(name);
  await saveJournal();
  console.log("PASS: " + name);
};
try {
  const initial = await call("refresh");
  const alternate = before.options.find(
    (option) => option.id !== before.status,
  )?.id;
  assert.ok(alternate, "試験用の別状態がありません");
  fault = "network";
  let pending = await edit("status", alternate);
  assert.ok(pending.pending);
  assert.equal(pending.lastSuccess, initial.lastSuccess);
  assert.equal(writes, 0);
  // 保存済みJSONを新しい保存先オブジェクトで読み直し、メモリに依存しない復旧を確認。
  storage = { ...storage };
  assert.equal((await call("state")).pending.id, pending.pending.id);
  fault = "permission";
  pending = await call("retry", { id: pending.pending.id });
  assert.match(pending.error, /権限不足/);
  assert.equal(writes, 0);
  fault = null;
  const success = await call("retry", { id: pending.pending.id });
  assert.equal(success.pending, null);
  assert.equal((await real.read()).status, alternate);
  await record("通信・権限失敗の注入後、永続化した未同期から実GitHubへ復旧");

  const deadline = before.due === "2030-02-19" ? "2030-02-20" : "2030-02-19";
  fault = "lost-response";
  pending = await edit("due", deadline);
  assert.ok(pending.pending);
  const writesBeforeRetry = writes;
  storage = { ...storage };
  fault = null;
  const confirmed = await call("retry", { id: pending.pending.id });
  assert.equal(confirmed.pending, null);
  assert.equal(writes, writesBeforeRetry, "成功済みの書き込みを再送しました");
  await record(
    "実書き込み後の応答喪失を注入し、再起動相当の読込後に再送せず照合",
  );

  await call("refresh");
  const externalDue = "2030-03-21";
  await guardedWrite("due", externalDue);
  const countBeforeConflict = writes;
  const conflict = await edit("status", before.status);
  assert.match(conflict.phase, /競合/);
  assert.equal(writes, countBeforeConflict);
  await assert.rejects(edit("status", before.status));
  const retry = await call("retry", { id: conflict.pending.id });
  assert.match(retry.phase, /競合/);
  assert.equal(writes, countBeforeConflict);
  await call("discard", { id: conflict.pending.id });
  await record(
    "実GitHubの外部変更を検知して上書き停止し、二重編集と競合再送を拒否",
  );
} finally {
  fault = null;
  assert.ok(
    !journal.intent,
    "結果不明の書き込みがあり、自動復元を停止しました",
  );
  assert.ok(
    same(expected, await real.read()),
    "外部変更があり、自動復元を停止しました",
  );
  if (expected.status !== before.status)
    await guardedWrite("status", before.status);
  if (expected.due !== before.due) await guardedWrite("due", before.due);
  const restored = await real.read();
  assert.equal(restored.status, before.status);
  assert.equal(restored.due, before.due);
  journal.restored = restored;
  journal.completed = journal.cases.length === 3;
  await saveJournal();
  console.log("RESTORED: 試験前の状態・期限を独立再取得で確認");
}
