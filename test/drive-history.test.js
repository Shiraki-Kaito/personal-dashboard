import test from "node:test";
import assert from "node:assert/strict";
import { refreshDrive } from "../src/drive.js";
import {
  beginDriveRun,
  finishDriveRun,
  driveHistoryLimit,
} from "../src/drive-history.js";
function memory(data = new Map()) {
  const storage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async (key) => data.delete(key),
  };
  storage.transaction = async (fn) => fn(storage);
  return storage;
}

test("想定外の応答でも古い一覧を保持し、警告と失敗履歴を残す", async () => {
  const storage = memory();
  const now = Date.now();
  await storage.put("drive:credential", {
    token: "fixture",
    expires: now + 3600000,
    accountFingerprint: "fixture",
  });
  await storage.put("drive:cache", {
    scope: "root:true",
    files: [{ id: "cached" }],
    lastSuccess: "2026-11-12T00:00:00Z",
  });
  const view = await refreshDrive(
    {
      GOOGLE_CLIENT_ID: "1-fixture.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "fixture",
      DRIVE_CONFIG: JSON.stringify({
        folderId: "root",
        includeSubfolders: true,
      }),
    },
    storage,
    async () => Response.json(null),
    now,
  );
  assert.equal(view.errorCode, "unexpected");
  assert.equal(view.runHistory[0].outcome, "failure");
  assert.equal(view.lastSuccess, "2026-11-12T00:00:00Z");
  assert.equal(view.files[0].id, "cached");
  assert.equal(view.scanning, false);
  assert.equal(view.recovery, null);
});
test("分割取得の再起動後も開始時刻と起点を保持し、結果を重複記録しない", async () => {
  const data = new Map();
  await beginDriveRun(memory(data), "cron", 1000);
  await beginDriveRun(memory(data), "manual", 2000);
  const storage = memory(data);
  await finishDriveRun(
    storage,
    {
      files: [{ name: "private-name", token: "private-token" }],
      folderCount: 3,
    },
    3000,
  );
  await finishDriveRun(storage, { files: [] }, 4000);
  const history = await storage.get("drive:history");
  assert.equal(history.length, 1);
  assert.equal(history[0].source, "cron");
  assert.equal(history[0].startedAt, new Date(1000).toISOString());
  assert.equal(history[0].finishedAt, new Date(3000).toISOString());
  assert.equal(history[0].fileCount, 1);
  assert.equal(JSON.stringify(history).includes("private-"), false);
});
test("履歴上限を守り、成功と失敗を区別して最新から残す", async () => {
  const storage = memory();
  for (let index = 0; index < driveHistoryLimit + 3; index++) {
    await beginDriveRun(storage, "manual", index * 1000);
    await finishDriveRun(
      storage,
      { files: [], errorCode: index % 2 ? "authentication" : null },
      index * 1000 + 1,
    );
  }
  const history = await storage.get("drive:history");
  assert.equal(history.length, driveHistoryLimit);
  assert.equal(history[0].outcome, "success");
  assert.equal(history[1].errorCode, "authentication");
  assert.equal(history.at(-1).startedAt, new Date(3000).toISOString());
});
