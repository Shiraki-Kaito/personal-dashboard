import { InputError } from "./sync.js";
import { groupView } from "./drive-groups.js";

const stateKey = "drive:groupDisplay";
const maximumOverrides = 128;
export function defaultGroupVisible(path) {
  return /^(?:100|200|300|400)(?:[_\s-]|$)/.test(
    path.split(" / ").at(-1).normalize("NFKC"),
  );
}
export function normalizeGroupDisplay(value) {
  if (
    !value ||
    typeof value.scope !== "string" ||
    !value.scope ||
    !Array.isArray(value.overrides) ||
    value.overrides.length > maximumOverrides ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.revision)
  )
    throw new InputError("グループ表示設定の形式が不正です");
  const seen = new Set();
  const overrides = value.overrides
    .map((item) => {
      if (
        !item ||
        typeof item.path !== "string" ||
        !item.path ||
        item.path.length > 1000 ||
        /[\u0000-\u001f\u007f]/.test(item.path) ||
        typeof item.visible !== "boolean" ||
        seen.has(item.path)
      )
        throw new InputError("グループの表示対象が不正です");
      seen.add(item.path);
      return { path: item.path, visible: item.visible };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "ja"));
  const result = { scope: value.scope, revision: value.revision, overrides };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024)
    throw new InputError(
      "表示設定の保存容量上限です。既存設定は変更していません",
    );
  return result;
}
export function groupDisplayView(scope, groups, saved) {
  const store = saved?.scope === scope ? normalizeGroupDisplay(saved) : null;
  const overrides = store?.overrides || [];
  return {
    scope,
    revision: store?.revision || null,
    overrides,
    groups: groups.map((group) => ({
      path: group.path,
      name: group.name,
      defaultVisible: defaultGroupVisible(group.path),
      visible:
        overrides.find((item) => item.path === group.path)?.visible ??
        defaultGroupVisible(group.path),
    })),
  };
}
export async function saveGroupDisplay(storage, scope, input) {
  if (
    input?.scope !== scope ||
    !(
      input.expectedRevision === null ||
      typeof input.expectedRevision === "string"
    )
  )
    throw new InputError("Driveの接続範囲・表示設定の版を確認してください");
  return storage.transaction(async (tx) => {
    const cache = await tx.get("drive:cache"),
      previous = await tx.get(stateKey);
    if (cache?.scope !== scope || (previous && previous.scope !== scope))
      throw new InputError(
        "Driveの接続範囲が変わりました。表示設定を上書きせず停止しました",
      );
    if ((previous?.revision || null) !== input.expectedRevision)
      throw new InputError(
        "別の画面で表示設定が変わりました。再取得して確認してください",
      );
    const next = normalizeGroupDisplay({
      scope,
      overrides: input.overrides,
      revision: crypto.randomUUID(),
    });
    const groups = groupView(cache, await tx.get("drive:groups"));
    const allowed = new Set([
      ...groups.map((group) => group.path),
      ...(previous?.overrides || []).map((item) => item.path),
    ]);
    if (next.overrides.some((item) => !allowed.has(item.path)))
      throw new InputError("取得済みのグループから表示対象を選んでください");
    await tx.put(stateKey, next);
    return next;
  });
}
