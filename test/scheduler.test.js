import test from "node:test";
import assert from "node:assert/strict";
import {
  nextAlarmAt,
  scheduleAlarm,
  runHourlyDrive,
} from "../src/scheduler.js";
function memory() {
  const data = new Map();
  let alarm = null;
  return {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => data.set(k, structuredClone(v)),
    delete: async (k) => data.delete(k),
    getAlarm: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}
test("Driveの続きと認証期限の最も早い時刻にAlarmを設定する", async () => {
  const s = memory(),
    now = 1000;
  await s.put("session", { expires: 100000 });
  await s.put("drive:flow", { expires: 90000 });
  await s.put("drive:job", { nextBatchAt: 3000 });
  assert.equal(await nextAlarmAt(s, now), 3000);
  await scheduleAlarm(s, now);
  assert.equal(await s.getAlarm(), 3000);
  await s.delete("drive:job");
  assert.equal(await nextAlarmAt(s, now), 90000);
  await s.delete("drive:flow");
  await s.delete("session");
  await scheduleAlarm(s, now);
  assert.equal(await s.getAlarm(), null);
});
test("未接続でも毎時の起動時刻を記録し、取得成功にしない", async () => {
  const s = memory(),
    now = Date.parse("2026-11-11T04:00:00Z");
  const result = await runHourlyDrive({}, s, () => assert.fail(), now);
  assert.equal(result.lastSuccess, null);
  assert.equal(result.connected, false);
  const record = await s.get("drive:scheduler");
  assert.equal(record.lastTriggeredAt, "2026-11-11T04:00:00.000Z");
  assert.ok(record.error);
});
