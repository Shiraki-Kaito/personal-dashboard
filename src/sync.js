import { RemoteError } from "./github.js";
export class InputError extends Error {}
export function same(a, b) {
  return (
    !!a && !!b && ["revision", "status", "due"].every((k) => a[k] === b[k])
  );
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value))
    return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}
export async function synchronize(action, input, config, api, storage) {
  const state = (await storage.get("sync")) || {
    remote: null,
    pending: null,
    lastAttempt: null,
    lastSuccess: null,
    error: null,
    phase: "未取得",
  };
  const persist = () => storage.put("sync", state);
  if (action === "edit") {
    const { field, value, base } = input;
    if (state.pending || !same(base, state.remote))
      throw new InputError("画面を再取得してください");
    if (!(
      (field === "status" && config.options.some((o) => o.id === value)) ||
      (field === "due" && (value === null || validDate(value)))
    ))
      throw new InputError("入力値が不正です");
    state.pending = {
      id: crypto.randomUUID(),
      field,
      value,
      base: state.remote,
    };
    state.phase = "未同期";
    await persist();
  }
  if (
    ["retry", "discard"].includes(action) &&
    (!state.pending || state.pending.id !== input.id)
  )
    throw new InputError("未同期操作が変更されています");
  if (action === "discard") {
    state.pending = null;
    await persist();
  }
  async function read() {
    state.lastAttempt = new Date().toISOString();
    await persist();
    state.remote = await api.read();
    state.lastSuccess = new Date().toISOString();
    state.error = null;
  }
  if (action !== "state") {
    if (state.retryAt > Date.now())
      return { ...state, options: config.options, projectUrl: config.url };
    state.retryAt = null;
    try {
      await read();
      const p = state.pending;
      if (!p) state.phase = "取得成功";
      else if (state.remote[p.field] === p.value) {
        state.pending = null;
        state.phase = "GitHubで希望値を確認";
      } else if (!same(p.base, state.remote)) state.phase = "競合・上書き停止";
      else if (action === "edit" || action === "retry") {
        state.phase = "書き込み結果未確認";
        await persist();
        await api.write(p.field, p.value);
        await read();
        if (state.remote[p.field] === p.value) {
          state.phase = "反映確認済み";
          state.pending = null;
        } else state.phase = "照合不一致・上書き停止";
      } else state.phase = "未同期・再試行待ち";
    } catch (e) {
      if (!(e instanceof RemoteError)) throw e;
      state.error = e.message;
      state.retryAt = e.retryAt;
      state.phase = state.pending ? "未同期・結果未確認" : "取得失敗";
    }
    await persist();
  }
  return { ...state, options: config.options, projectUrl: config.url };
}
