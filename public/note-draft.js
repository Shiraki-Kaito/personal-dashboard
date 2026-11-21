const maximumBytes = 256 * 1024;
// 元の版と編集結果を分け、エクスポートをGitHub保存成功として扱わない。
export class NoteDraft {
  constructor(note) {
    if (!note || typeof note.text !== "string" || typeof note.path !== "string" ||
      note.path.split("/").some(part => !part || part === "." || part === ".." || /_L\.md$/i.test(part)) ||
      /[\\\u0000-\u001f]/.test(note.path) || !/\.md$/i.test(note.path) ||
      !/^[a-f0-9]{40}$/.test(note.commit)) throw Error("編集元のノートが不正です");
    this.path = note.path;
    this.commit = note.commit;
    this.original = note.text;
    this.text = note.text;
    this.exportedText = null;
  }
  get dirty() { return this.text !== this.original && this.text !== this.exportedText; }
  exportText() {
    if (new TextEncoder().encode(this.text).length > maximumBytes)
      throw Error("下書きはUTF-8で256KiB以内にしてください");
    return this.text;
  }
  markExported(text) { this.exportedText = text; }
  get filename() { return this.path.split("/").at(-1).replace(/\.md$/i, ".draft.md"); }
}
