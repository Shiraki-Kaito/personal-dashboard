import { InputError } from "./sync.js";
import { ownerId } from "./github.js";
import { NotesError, notesRequest } from "./notes-http.js";

const maximumTreeEntries = 5000;
const maximumNotes = 1000;
const maximumNoteBytes = 256 * 1024;
const maximumIndexBytes = 512 * 1024;
const freshMs = 60 * 60 * 1000;
const refreshIntervalMs = 60 * 1000;
const shaPattern = /^[a-f0-9]{40}$/;
const validPath = (path) =>
  typeof path === "string" &&
  path.length <= 1000 &&
  !/[\\\u0000-\u001f\u007f]/.test(path) &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
// パスのどの階層にもローカル限定名を許さず、本文APIに到達させない。
export const excludedNotePath = (path) =>
  typeof path !== "string" ||
  path.split("/").some((part) => /_L\.md$/i.test(part));
const repositoryPath = (config) => "/repos/" + config.owner + "/" + config.repo;
const sourceUrl = (config, commit, path) =>
  "https://github.com/" +
  config.owner +
  "/" +
  config.repo +
  "/blob/" +
  commit +
  "/" +
  path.split("/").map(encodeURIComponent).join("/");

export function noteSettings(input) {
  let url;
  try {
    url = new URL(input.repository);
  } catch {
    throw new InputError("GitHubリポジトリのURLを入力してください");
  }
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    !/^[A-Za-z0-9-]{1,39}$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) ||
    [".", ".."].includes(parts[1])
  )
    throw new InputError(
      "https://github.com/所有者/リポジトリ の形式で入力してください",
    );
  const folder =
    typeof input.folder === "string"
      ? input.folder.trim().replace(/^\/+|\/+$/g, "")
      : "";
  if (
    folder &&
    (!validPath(folder) ||
      folder.split("/").length > 8 ||
      excludedNotePath(folder))
  )
    throw new InputError(
      "対象フォルダが不正です。ルートの場合は空欄にしてください（最大8階層）",
    );
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  if (branch.length > 200 || /[\u0000-\u0020\\?#]/.test(branch))
    throw new InputError("ブランチ名が不正です");
  return { owner: parts[0], repo: parts[1], folder, branch };
}

async function loadTree(config, request) {
  const root = repositoryPath(config);
  const repo = await request(root);
  if (!repo?.default_branch || typeof repo.default_branch !== "string")
    throw new NotesError("リポジトリ情報が不正です", "invalid_response");
  if (!config.private && repo.private !== false)
    throw new NotesError(
      "非公開リポジトリには専用の読み取りトークンが必要です",
      "permission",
    );
  const branch = config.branch || repo.default_branch;
  const commit = await request(root + "/commits/" + encodeURIComponent(branch));
  if (
    !shaPattern.test(commit?.sha) ||
    !shaPattern.test(commit.commit?.tree?.sha)
  )
    throw new NotesError("コミット情報が不正です", "invalid_response");
  let treeSha = commit.commit.tree.sha;
  for (const part of config.folder ? config.folder.split("/") : []) {
    const tree = await request(root + "/git/trees/" + treeSha);
    assertTree(tree, treeSha);
    const child = tree.tree.find(
      (entry) =>
        entry.path === part && entry.type === "tree" && entry.mode === "040000",
    );
    if (!child || !shaPattern.test(child.sha))
      throw new NotesError("対象フォルダが見つかりません", "not_found");
    treeSha = child.sha;
  }
  const tree = await request(root + "/git/trees/" + treeSha + "?recursive=1");
  assertTree(tree, treeSha);
  const files = [],
    paths = new Set();
  for (const entry of tree.tree) {
    if (!validPath(entry.path) || paths.has(entry.path))
      throw new NotesError(
        "一覧のパスが不正または重複しています",
        "invalid_response",
      );
    paths.add(entry.path);
    if (
      excludedNotePath(entry.path) ||
      !/\.md$/i.test(entry.path) ||
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode)
    )
      continue;
    if (
      !shaPattern.test(entry.sha) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    )
      throw new NotesError("ノートの識別情報が不正です", "invalid_response");
    const path = (config.folder ? config.folder + "/" : "") + entry.path;
    if (!validPath(path) || excludedNotePath(path))
      throw new NotesError("対象パスが不正です", "invalid_response");
    files.push({
      path,
      sha: entry.sha,
      size: entry.size,
      readable: entry.size <= maximumNoteBytes,
      url: sourceUrl(config, commit.sha, path),
    });
  }
  if (
    files.length > maximumNotes ||
    new TextEncoder().encode(JSON.stringify(files)).length > maximumIndexBytes
  )
    throw new NotesError(
      "ノート一覧の上限1000件／512KiBを超えました。対象フォルダを絞ってください",
      "limit",
    );
  files.sort((a, b) => a.path.localeCompare(b.path, "ja"));
  return { files, commit: commit.sha, branch, treeEntries: tree.tree.length };
}
function assertTree(tree, sha) {
  if (tree?.truncated === true || tree?.tree?.length > maximumTreeEntries)
    throw new NotesError(
      "GitHubの一覧が省略されたか、5000項目の上限を超えました。対象フォルダを絞ってください",
      "limit",
    );
  if (
    tree?.sha !== sha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree)
  )
    throw new NotesError("GitHubの一覧形式が不正です", "invalid_response");
}

// 秘密値・除外されたパス・本文は一覧APIへ返さない。
export async function notesView(storage, now = Date.now()) {
  const config = await storage.get("notes:config");
  const cache = await storage.get("notes:cache");
  return {
    configured: !!config,
    config: config || null,
    files: cache?.files || [],
    commit: cache?.commit || null,
    branch: cache?.branch || null,
    treeEntries: cache?.treeEntries ?? null,
    lastAttempt: cache?.lastAttempt || null,
    lastSuccess: cache?.lastSuccess || null,
    error: cache?.error || null,
    errorCode: cache?.errorCode || null,
    retryAt: cache?.retryAt || null,
    stale:
      !!config &&
      (!cache?.lastSuccess ||
        !!cache.error ||
        now - Date.parse(cache.lastSuccess) > freshMs),
    maximumNoteBytes,
    maximumNotes,
  };
}
export async function configureNotes(
  storage,
  input,
  send = fetch,
  now = Date.now(),
) {
  if (input.confirm !== true)
    throw new InputError("ノートの取得対象と読み取り権限を確認してください");
  const config = { ...noteSettings(input), private: input.private === true };
  const old = await storage.get("notes:config");
  let token = null;
  if (config.private) {
    token =
      input.token ||
      (old?.owner === config.owner && old?.repo === config.repo
        ? await storage.get("notes:token")
        : null);
    if (
      typeof token !== "string" ||
      !/^github_pat_[A-Za-z0-9_]{20,250}$/.test(token)
    )
      throw new InputError(
        "対象リポジトリだけのFine-grained token（Contents: Read-only）を入力してください",
      );
    const user = await notesRequest(token, send)("/user");
    if (user?.node_id !== ownerId)
      throw new InputError("本人以外のノート接続は登録できません");
  }
  const loaded = await loadTree(config, notesRequest(token, send));
  await storage.transaction(async (tx) => {
    await tx.put("notes:config", config);
    if (token) await tx.put("notes:token", token);
    else await tx.delete("notes:token");
    await tx.put("notes:cache", {
      ...loaded,
      lastAttempt: new Date(now).toISOString(),
      lastSuccess: new Date(now).toISOString(),
    });
  });
  return notesView(storage, now);
}
export async function refreshNotes(storage, send = fetch, now = Date.now()) {
  const config = await storage.get("notes:config");
  if (!config) throw new InputError("先にノートの取得対象を設定してください");
  const cache = (await storage.get("notes:cache")) || {};
  if (
    cache.retryAt > now ||
    now - Date.parse(cache.lastAttempt) < refreshIntervalMs
  )
    throw new InputError("続けての取得は待ってから実行してください");
  const lastAttempt = new Date(now).toISOString();
  // 途中で処理が中断されても、前回成功を残して未完了を表示する。
  await storage.put("notes:cache", {
    ...cache,
    lastAttempt,
    error: "ノート一覧の取得が未完了です",
    errorCode: "interrupted",
    retryAt: null,
  });
  try {
    const token = config.private ? await storage.get("notes:token") : null;
    if (config.private && !token)
      throw new NotesError("専用トークンを設定し直してください", "auth");
    const loaded = await loadTree(config, notesRequest(token, send));
    await storage.put("notes:cache", {
      ...loaded,
      lastAttempt,
      lastSuccess: new Date(now).toISOString(),
    });
  } catch (error) {
    if (!(error instanceof NotesError)) throw error;
    await storage.put("notes:cache", {
      ...cache,
      lastAttempt,
      error: error.message,
      errorCode: error.code,
      retryAt: error.retryAt,
    });
  }
  return notesView(storage, now);
}
export async function readNote(storage, input, send = fetch) {
  if (!validPath(input.path) || excludedNotePath(input.path))
    throw new InputError("対象外のノートです");
  const view = await notesView(storage);
  if (!view.configured || view.stale)
    throw new InputError("先にノート一覧を正常に更新してください");
  const file = view.files.find(
    (entry) => entry.path === input.path && entry.sha === input.sha,
  );
  if (!file)
    throw new InputError(
      "ノートが変更されています。一覧から選び直してください",
    );
  if (!file.readable)
    throw new InputError(
      "本文の上限256KiBを超えています。GitHubで確認してください",
    );
  const token = view.config.private ? await storage.get("notes:token") : null;
  if (view.config.private && !token)
    throw new InputError("専用トークンを設定し直してください");
  const blob = await notesRequest(
    token,
    send,
  )(repositoryPath(view.config) + "/git/blobs/" + file.sha);
  if (
    blob.sha !== file.sha ||
    blob.size !== file.size ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string"
  )
    throw new NotesError("ノート本文の形式が不正です", "invalid_response");
  let bytes;
  try {
    bytes = Uint8Array.from(atob(blob.content.replace(/\s/g, "")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new NotesError("ノート本文を読み取れません", "invalid_response");
  }
  if (bytes.length !== file.size || bytes.length > maximumNoteBytes)
    throw new NotesError(
      "ノート本文のサイズが一致しません",
      "invalid_response",
    );
  const header = new TextEncoder().encode("blob " + bytes.length + "\0");
  const gitBytes = new Uint8Array(header.length + bytes.length);
  gitBytes.set(header);
  gitBytes.set(bytes, header.length);
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-1", gitBytes)),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== file.sha)
    throw new NotesError("ノート本文の版が一致しません", "invalid_response");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NotesError("UTF-8のノートだけ表示できます", "invalid_response");
  }
  return {
    path: file.path,
    sha: file.sha,
    url: file.url,
    commit: view.commit,
    text,
  };
}
export async function stopNotes(storage, input) {
  if (input.confirm !== true)
    throw new InputError("ノート接続の停止を確認してください");
  await storage.transaction(async (tx) => {
    for (const key of ["notes:token", "notes:config", "notes:cache"])
      await tx.delete(key);
  });
  return notesView(storage);
}
