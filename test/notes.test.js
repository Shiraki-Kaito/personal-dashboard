import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  noteSettings,
  excludedNotePath,
  configureNotes,
  notesView,
  refreshNotes,
  readNote,
  stopNotes,
} from "../src/notes.js";
import { notesRequest } from "../src/notes-http.js";
import { ownerId } from "../src/github.js";

const now = Date.now();
const rootSha = "a".repeat(40),
  commitSha = "b".repeat(40),
  folderSha = "c".repeat(40);
const text =
  "# 研究ノート\n<script>alert('fixture')</script>\n![](https://example.test/tracker)";
const bytes = Buffer.from(text);
const sha = createHash("sha1")
  .update("blob " + bytes.length + "\0")
  .update(bytes)
  .digest("hex");
const file = (path, extra = {}) => ({
  path,
  mode: "100644",
  type: "blob",
  sha,
  size: bytes.length,
  ...extra,
});
const settings = {
  repository: "https://github.com/Shiraki-Kaito/obsidian-notes",
  folder: "",
  confirm: true,
};
const token = "github_pat_" + "fixture".repeat(5);
function memory(values = new Map()) {
  const storage = {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    transaction: async (fn) => fn(storage),
  };
  return storage;
}
function fixture({
  entries = [
    file("研究.md"),
    file("秘密_L.md"),
    file("sub/SECRET_l.MD"),
    file("alias.md", { mode: "120000" }),
  ],
  privateRepo = false,
  user = ownerId,
} = {}) {
  const calls = [];
  let failure = null,
    truncated = false,
    blob = null;
  const send = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(new URL(url).hostname, "api.github.com");
    calls.push({ url, options });
    if (failure)
      return new Response("do not expose secret fixture", { status: failure });
    const path = new URL(url).pathname;
    if (path === "/user") return Response.json({ node_id: user });
    if (path.endsWith("/obsidian-notes"))
      return Response.json({ default_branch: "main", private: privateRepo });
    if (path.includes("/commits/"))
      return Response.json({
        sha: commitSha,
        commit: { tree: { sha: rootSha } },
      });
    if (path.endsWith("/git/blobs/" + sha))
      return Response.json(
        blob || {
          sha,
          size: bytes.length,
          encoding: "base64",
          content: bytes.toString("base64"),
        },
      );
    if (path.includes("/git/trees/")) {
      const treeSha = path.split("/").at(-1);
      return Response.json({
        sha: treeSha,
        truncated,
        tree: new URL(url).search
          ? entries
          : [{ path: "notes", mode: "040000", type: "tree", sha: folderSha }],
      });
    }
    throw Error("unexpected request " + url);
  };
  return {
    calls,
    send,
    setFailure: (status) => (failure = status),
    truncate: () => (truncated = true),
    setBlob: (value) => (blob = value),
  };
}

test("ノート設定はGitHubのリポジトリURLと限定フォルダだけを受け付ける", () => {
  assert.deepEqual(
    noteSettings({ ...settings, folder: "/研究/運営/", branch: "main" }),
    {
      owner: "Shiraki-Kaito",
      repo: "obsidian-notes",
      folder: "研究/運営",
      branch: "main",
    },
  );
  for (const repository of [
    "https://evil.test/a/b",
    "https://github.com/a/b/tree/main",
    "https://x:y@github.com/a/b",
    "https://github.com/a/b?token=secret",
  ])
    assert.throws(() => noteSettings({ ...settings, repository }));
  for (const folder of [
    "../notes",
    "a//b",
    "a\\b",
    "secret_L.md/notes",
    "a/".repeat(9),
  ])
    assert.throws(() => noteSettings({ ...settings, folder }));
  for (const path of ["secret_L.md", "x/a_l.MD", "x_L.md/file.md"])
    assert.equal(excludedNotePath(path), true);
  assert.equal(excludedNotePath("research.md"), false);
});

test("除外名・シンボリックリンクを保存も送信もせず、選択した版の本文だけ取得", async () => {
  const s = memory(),
    f = fixture();
  const view = await configureNotes(s, settings, f.send, now);
  assert.deepEqual(
    view.files.map((x) => x.path),
    ["研究.md"],
  );
  assert.equal(view.treeEntries, 4);
  assert.equal(view.stale, false);
  assert.equal(JSON.stringify([...s.values]).includes("秘密_L.md"), false);
  assert.equal(
    f.calls.some((c) => c.url.includes("/blobs/")),
    false,
  );
  const count = f.calls.length;
  for (const path of [
    "秘密_L.md",
    "sub/SECRET_l.MD",
    "../研究.md",
    "alias.md",
    "other.md",
  ])
    await assert.rejects(readNote(s, { path, sha }, f.send));
  assert.equal(f.calls.length, count);
  const note = await readNote(s, { path: "研究.md", sha }, f.send);
  assert.equal(note.text, text);
  assert.match(note.url, new RegExp("/blob/" + commitSha + "/"));
  assert.equal(JSON.stringify([...s.values]).includes("<script>"), false);
});

test("対象フォルダのツリーを固定コミットから解決し、他フォルダを列挙しない", async () => {
  const s = memory(),
    f = fixture();
  const view = await configureNotes(
    s,
    { ...settings, folder: "notes", branch: "feature/notes" },
    f.send,
    now,
  );
  assert.equal(view.files[0].path, "notes/研究.md");
  assert.equal(
    f.calls.some((c) => c.url.endsWith("/commits/feature%2Fnotes")),
    true,
  );
  assert.equal(
    f.calls.some((c) =>
      c.url.endsWith("/git/trees/" + folderSha + "?recursive=1"),
    ),
    true,
  );
  assert.equal(
    f.calls.some((c) =>
      c.url.endsWith("/git/trees/" + rootSha + "?recursive=1"),
    ),
    false,
  );
});

test("非公開は専用Fine-grained tokenの本人照合を必須としAPIへ秘密を返さない", async () => {
  const s = memory(),
    f = fixture({ privateRepo: true });
  await assert.rejects(configureNotes(s, settings, f.send, now), /非公開/);
  await assert.rejects(
    configureNotes(
      s,
      { ...settings, private: true, token: "ghp_classic" },
      f.send,
      now,
    ),
  );
  await assert.rejects(
    configureNotes(
      s,
      { ...settings, private: true, token },
      fixture({ privateRepo: true, user: "other" }).send,
      now,
    ),
    /本人以外/,
  );
  const view = await configureNotes(
    s,
    { ...settings, private: true, token },
    f.send,
    now,
  );
  assert.equal(await s.get("notes:token"), token);
  assert.equal(JSON.stringify(view).includes(token), false);
  await configureNotes(s, { ...settings, private: true }, f.send, now);
  assert.equal(f.calls.at(-1).options.headers.Authorization, "Bearer " + token);
  assert.equal(JSON.stringify(await notesView(s)).includes(token), false);
  await assert.rejects(
    configureNotes(
      s,
      {
        ...settings,
        repository: "https://github.com/other/repo",
        private: true,
      },
      f.send,
      now,
    ),
  );
});

test("取得失敗は最終成功と一覧を保持し、古い本文を取得せず、再取得で復旧", async () => {
  const s = memory(),
    f = fixture();
  const initial = await configureNotes(s, settings, f.send, now);
  f.setFailure(401);
  const failed = await refreshNotes(s, f.send, now + 61000);
  assert.deepEqual(failed.files, initial.files);
  assert.equal(failed.lastSuccess, initial.lastSuccess);
  assert.notEqual(failed.lastAttempt, initial.lastAttempt);
  assert.equal(failed.errorCode, "auth");
  assert.equal(failed.stale, true);
  await assert.rejects(readNote(s, { path: "研究.md", sha }, f.send), /一覧/);
  f.setFailure(null);
  const restored = await refreshNotes(
    memory(structuredClone(s.values)),
    f.send,
    now + 122000,
  );
  assert.equal(restored.error, null);
  assert.equal(restored.stale, false);
});

test("省略一覧・重複・取得上限を成功扱いせず、設定失敗で以前の接続を壊さない", async () => {
  const s = memory(),
    f = fixture();
  await configureNotes(s, settings, f.send, now);
  const initial = structuredClone(s.values);
  f.truncate();
  await assert.rejects(configureNotes(s, settings, f.send, now), /省略/);
  assert.deepEqual(s.values, initial);
  for (const entries of [
    [file("a.md"), file("a.md")],
    Array.from({ length: 1001 }, (_, i) => file(i + ".md")),
    [file("../outside.md")],
  ]) {
    const view = await refreshNotes(s, fixture({ entries }).send, now + 61000);
    assert.equal(view.stale, true);
    assert.equal(view.files.length, 1);
    await s.put("notes:cache", initial.get("notes:cache"));
  }
});

test("本文上限・SHA不整合・不正base64を拒否し、任意SHAへアクセスしない", async () => {
  const s = memory(),
    f = fixture();
  await configureNotes(s, settings, f.send, now);
  await assert.rejects(
    readNote(s, { path: "研究.md", sha: "c".repeat(40) }, f.send),
  );
  f.setBlob({
    sha,
    size: bytes.length,
    encoding: "base64",
    content: Buffer.alloc(bytes.length, 65).toString("base64"),
  });
  await assert.rejects(readNote(s, { path: "研究.md", sha }, f.send), /版/);
  f.setBlob({ sha, size: bytes.length, encoding: "base64", content: "%%%" });
  await assert.rejects(readNote(s, { path: "研究.md", sha }, f.send));
  const large = fixture({
    entries: [file("large.md", { size: 256 * 1024 + 1 })],
  });
  const view = await configureNotes(s, settings, large.send, now);
  assert.equal(view.files[0].readable, false);
  const before = large.calls.length;
  await assert.rejects(
    readNote(s, { path: "large.md", sha }, large.send),
    /上限/,
  );
  assert.equal(large.calls.length, before);
});

test("REST認証・権限・削除・レート制限を区別して本文や秘密をエラーへ含めない", async () => {
  for (const [status, code] of [
    [401, "auth"],
    [403, "permission"],
    [404, "not_found"],
    [429, "rate_limit"],
  ]) {
    let calls = 0;
    await assert.rejects(
      notesRequest(token, async () => {
        calls++;
        return new Response(token, { status });
      })("/user"),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    notesRequest(token, async () =>
      Response.json({ pad: "x".repeat(2 * 1024 * 1024) }),
    )("/user"),
    (error) => error.code === "limit",
  );
  await assert.rejects(
    notesRequest(token, async () => {
      throw Object.assign(Error("secret"), { name: "TimeoutError" });
    })("/user"),
    (error) => error.code === "timeout",
  );
  let calls = 0;
  await assert.rejects(
    notesRequest(token, async () => {
      calls++;
      throw Error("secret");
    })("/user"),
    (error) => error.code === "network",
  );
  assert.equal(calls, 2);
});

test("結果不明・再起動でも以前の一覧が残り、未確認削除を拒否して別サービスに触れない", async () => {
  const s = memory(),
    f = fixture();
  await configureNotes(s, settings, f.send, now);
  await s.put("unrelated", { safe: true });
  await assert.rejects(stopNotes(s, {}));
  const cache = await s.get("notes:cache");
  await s.put("notes:cache", {
    ...cache,
    error: "取得未完了",
    lastAttempt: new Date(now + 61000).toISOString(),
  });
  const restarted = memory(structuredClone(s.values));
  assert.equal((await notesView(restarted)).stale, true);
  await stopNotes(restarted, { confirm: true });
  assert.equal((await notesView(restarted)).configured, false);
  assert.deepEqual(await restarted.get("unrelated"), { safe: true });
  assert.equal(await restarted.get("notes:token"), undefined);
});
