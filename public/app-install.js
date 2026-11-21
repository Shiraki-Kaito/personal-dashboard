// ブラウザーのインストールイベントを所有し、二重起動と結果の早合点を防ぐ。
export class AppInstall {
  event = null;
  busy = false;
  installed = false;
  message = "";
  constructor(changed) {
    this.changed = changed;
  }
  offer(event) {
    event.preventDefault();
    if (!this.busy && !this.installed) this.event = event;
    this.changed();
  }
  complete() {
    this.installed = true;
    this.event = null;
    this.message =
      "インストールされました。端末のアプリ一覧またはホーム画面からPersonal Dashboardを開けます。";
    this.changed();
  }
  async prompt() {
    if (this.busy || !this.event || this.installed) return;
    const event = this.event;
    this.event = null;
    this.busy = true;
    this.message = "ブラウザーのインストール画面を確認してください。";
    this.changed();
    try {
      await event.prompt();
      const result = await event.userChoice;
      if (!this.installed)
        this.message =
          result.outcome === "accepted"
            ? "ブラウザーで受け付けました。追加の完了を確認してください。"
            : "インストールを見送りました。ブラウザーから引き続き利用できます。";
    } catch {
      if (!this.installed)
        this.message =
          "インストール画面を開けませんでした。ブラウザーのメニューから追加できます。";
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
