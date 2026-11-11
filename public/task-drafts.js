const sameSnapshot = (a, b) =>
  !!a && !!b && ["revision", "status", "due"].every((key) => a[key] === b[key]);

// 未送信の入力と、その入力を始めた時点のGitHub値を項目ごとに所有する。
export class TaskDrafts {
  entries = new Map();
  get dirty() {
    return this.entries.size > 0;
  }
  clear() {
    this.entries.clear();
  }
  edit(field, value, remote) {
    const base = this.entries.get(field)?.base || structuredClone(remote);
    if (value === base[field]) this.entries.delete(field);
    else this.entries.set(field, { value, base });
  }
  value(field, remote) {
    return this.entries.has(field)
      ? this.entries.get(field).value
      : remote?.[field];
  }
  submission(field) {
    const entry = this.entries.get(field);
    return entry ? { field, ...structuredClone(entry) } : null;
  }
  receive(result, submitted) {
    if (
      !submitted ||
      result.pending ||
      !result.remote ||
      result.remote[submitted.field] !== submitted.value
    )
      return;
    this.entries.delete(submitted.field);
    for (const [field, entry] of this.entries) {
      // 自分が反映した変更だけ基準を進める。他項目が外部で変われば古い基準を残す。
      if (
        sameSnapshot(entry.base, submitted.base) &&
        result.remote[field] === entry.base[field]
      ) {
        this.entries.set(field, {
          ...entry,
          base: structuredClone(result.remote),
        });
      }
    }
  }
}
