import test from "node:test";
import assert from "node:assert/strict";
import { assertBackupEnvelope } from "../public/backup-format.js";
test("誤って選んだ認証ファイルや秘密値のキーを送信前に拒否する", () => {
  const backup = {
    version: 1,
    ownerId: "owner",
    createdAt: "now",
    scope: {},
    tasks: [],
    drive: null,
  };
  assert.doesNotThrow(() => assertBackupEnvelope(backup));
  assert.throws(() =>
    assertBackupEnvelope({ client_id: "fixture", client_secret: "fixture" }),
  );
  assert.throws(() =>
    assertBackupEnvelope({
      ...backup,
      tasks: [{ remote: { token: "fixture" } }],
    }),
  );
  assert.doesNotThrow(() =>
    assertBackupEnvelope({
      ...backup,
      tasks: [{ remote: { title: "secretsという名前のタスク" } }],
    }),
  );
});
