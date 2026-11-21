// 誤って選択した認証ファイルをアップロードする前に、ブラウザー内で拒否する。
export function assertBackupEnvelope(value) {
  const message =
    "このアプリのバックアップJSONを選択してください。認証・設定ファイルは送信できません。";
  const keys = new Set([
    "version",
    "ownerId",
    "createdAt",
    "scope",
    "tasks",
    "drive",
    "driveGroups",
    "driveGroupDisplay",
    "driveMeetings",
    "weeklySettings",
    "agenda",
    "noteTaskLinks",
  ]);
  if (
    !value ||
    ![1, 2].includes(value.version) ||
    typeof value.ownerId !== "string" ||
    !value.scope ||
    !Array.isArray(value.tasks) ||
    Object.keys(value).some((key) => !keys.has(key))
  )
    throw Error(message);
  function inspect(item, depth = 0) {
    if (!item || typeof item !== "object") return;
    if (depth > 20) throw Error(message);
    for (const [key, child] of Object.entries(item)) {
      if (/token|secret|cookie|session|credential/i.test(key))
        throw Error(message);
      inspect(child, depth + 1);
    }
  }
  inspect(value);
}
