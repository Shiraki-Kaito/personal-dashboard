export class SessionExpiredError extends Error {
  constructor() {
    super(
      "ログインの有効期限が切れました。画面内の案内からログインし直してください",
    );
  }
}

// 401後は送信を止める。認証確認だけを許し、失敗した操作の内容や再送キューは持たない。
export class SessionConnection {
  expired = false;
  generation = 0;
  checking = null;
  constructor(send, changed = () => {}) {
    this.send = send;
    this.changed = changed;
  }
  fail(generation = this.generation) {
    if (generation !== this.generation || this.expired) return;
    this.expired = true;
    this.changed();
  }
  async request(url, options) {
    if (this.expired) throw new SessionExpiredError();
    const generation = this.generation;
    const response = await this.send(url, options);
    if (response.status === 401) {
      this.fail(generation);
      throw new SessionExpiredError();
    }
    return response;
  }
  check() {
    if (this.checking) return this.checking;
    this.checking = this.checkSession().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  async checkSession() {
    const response = await this.send("/api/session", { cache: "no-store" });
    if (response.status === 401) {
      this.fail();
      throw new SessionExpiredError();
    }
    if (!response.ok)
      throw Error(
        "ログイン状態を確認できません。通信状態を確認して再試行してください",
      );
    const result = await response.json();
    if (!Number.isFinite(result.expiresAt) || result.expiresAt <= 0)
      throw Error("ログイン状態の応答が不正です");
    this.generation++;
    this.expired = false;
    this.changed();
    return result;
  }
}
export const sessionConnection = new SessionConnection(
  (url, options) => globalThis.fetch(url, options),
  () => {
    if (typeof document !== "undefined")
      document.dispatchEvent(new Event("dashboard:session-state"));
  },
);
export const sessionFetch = (url, options) =>
  sessionConnection.request(url, options);
