import test from "node:test";
import assert from "node:assert/strict";
import {
  readReportRecord,
  writeReportRecord,
} from "../src/progress-record-store.js";
function fixture() {
  const values = new Map();
  return {
    values,
    get: async (k) => structuredClone(values.get(k)),
    put: async (k, v) => values.set(k, structuredClone(v)),
    delete: async (k) => values.delete(k),
  };
}
test("大きな日本語報告を欠落なく分割保存し、縮小後の不要な断片を整理する", async () => {
  const storage = fixture(),
    record = { id: "test", text: "根拠と報告😀".repeat(25000) };
  await writeReportRecord(storage, record);
  assert.deepEqual(await readReportRecord(storage, "test"), record);
  assert.ok(storage.values.size > 2);
  await writeReportRecord(storage, { id: "test", text: "短い報告" });
  assert.equal(storage.values.size, 2);
  assert.equal((await readReportRecord(storage, "test")).text, "短い報告");
});
test("旧形式を読み取り、欠けた断片と上限超過を拒否する", async () => {
  const storage = fixture();
  await storage.put("drive:progress:record:old", { id: "old", text: "以前" });
  assert.equal((await readReportRecord(storage, "old")).text, "以前");
  await writeReportRecord(storage, { id: "new", text: "a".repeat(200000) });
  await storage.delete("drive:progress:record:new:part:1");
  await assert.rejects(readReportRecord(storage, "new"), /不足/);
  await assert.rejects(
    writeReportRecord(storage, { id: "huge", text: "a".repeat(2200000) }),
    /2MiB/,
  );
  assert.equal(await storage.get("drive:progress:record:huge"), undefined);
});

test("断片の長さが同じでも内容の破損を検知する", async () => {
  const storage = fixture();
  await writeReportRecord(storage, { id: "checked", text: "根拠" });
  const key = "drive:progress:record:checked:part:0";
  const bytes = await storage.get(key);
  bytes[bytes.length - 3] ^= 1;
  await storage.put(key, bytes);
  await assert.rejects(readReportRecord(storage, "checked"), /一致しません/);
});
