// ドットや+タグは統合せず、登録されたアドレスそのものだけを照合する。
export function memberEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

export function driveEditorResolver(cache, groups) {
  const names = new Map();
  if (cache && groups?.scope === cache.scope) {
    for (const group of groups.records || []) for (const member of group.members || []) {
      const email = memberEmail(member.email);
      if (!email || !member.name?.trim()) continue;
      if (!names.has(email)) names.set(email, new Set());
      names.get(email).add(member.name.trim());
    }
  }
  return file => {
    const matches = names.get(memberEmail(file.lastModifiedEmail));
    const visible = publicDriveFile(file);
    // 別名で重複登録されている場合、チームや表示名から本人を推測しない。
    if (matches?.size !== 1) return { ...visible, editorNameSource: !memberEmail(file.lastModifiedEmail) ? "email-unavailable" : matches?.size > 1 ? "ambiguous" : "unregistered" };
    return { ...visible, lastModifiedBy: [...matches][0], editorNameSource: "member" };
  };
}

// 照合用情報はサーバーに残し、資料の表示応答には含めない。
export function publicDriveFile(file) {
  const { lastModifiedEmail, originalLastModifiedBy, ...visible } = file;
  return visible;
}
