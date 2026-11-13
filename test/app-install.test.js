import test from "node:test";
import assert from "node:assert/strict";
import { AppInstall } from "../public/app-install.js";
import { readFile } from "node:fs/promises";

test("インストールの二重起動を防ぎ、受け付けだけを完了扱いにしない", async () => {
  const app = new AppInstall(() => {});
  let calls = 0,
    resolveChoice,
    prevented = false;
  app.offer({
    preventDefault() {
      prevented = true;
    },
    prompt: async () => calls++,
    userChoice: new Promise((resolve) => {
      resolveChoice = resolve;
    }),
  });
  const first = app.prompt();
  await app.prompt();
  assert.equal(calls, 1);
  assert.equal(prevented, true);
  assert.equal(app.busy, true);
  resolveChoice({ outcome: "accepted" });
  await first;
  assert.equal(app.installed, false);
  app.complete();
  assert.equal(app.installed, true);
  assert.equal(app.event, null);
});

test("取消・起動失敗でも利用を継続でき、完了通知を遅い結果で取り消さない", async () => {
  const app = new AppInstall(() => {});
  const offer = (prompt, outcome) =>
    app.offer({
      preventDefault() {},
      prompt,
      userChoice: Promise.resolve({ outcome }),
    });
  offer(async () => {}, "dismissed");
  await app.prompt();
  assert.equal(app.busy, false);
  assert.equal(app.event, null);
  assert.match(app.message, /見送り/);
  offer(async () => {
    throw Error("fixture");
  });
  await app.prompt();
  assert.match(app.message, /開けません/);
  offer(async () => app.complete(), "dismissed");
  await app.prompt();
  assert.equal(app.installed, true);
  assert.match(app.message, /インストールされました/);
});

test("公開マニフェストは同じオリジンの通常ウィンドウと正しいPNGを指定する", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../public/manifest.webmanifest", import.meta.url)),
  );
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.id, "/");
  for (const icon of manifest.icons) {
    const bytes = await readFile(
      new URL("../public" + icon.src, import.meta.url),
    );
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(
      bytes.readUInt32BE(16) + "x" + bytes.readUInt32BE(20),
      icon.sizes,
    );
  }
});
