import test from "node:test";
import assert from "node:assert/strict";
import { installGuidance } from "../public/install-guidance.js";

test("iPhoneとデスクトップ形式のiPadに共有メニューの案内を出す", () => {
  for (const device of [{ userAgent: "iPhone" }, { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 }]) {
    const result = installGuidance(device);
    assert.equal(result.hideButton, true);
    assert.match(result.message, /Safari.*ホーム画面に追加/);
    assert.doesNotMatch(result.message, /完了しました/);
  }
});

test("MacをiPad扱いせず、未対応ブラウザーにも利用導線を残す", () => {
  for (const device of [{ platform: "MacIntel", maxTouchPoints: 0 }, {}, { userAgent: "Windows" }]) {
    const result = installGuidance(device);
    assert.equal(result.hideButton, true);
    assert.match(result.message, /ブラウザーで利用できます/);
  }
});

test("独立起動を標準とiOS両方で判定し、追加済みと起動中を区別する", () => {
  for (const state of [{ standalone: true }, { legacyStandalone: true }]) {
    assert.match(installGuidance(state).message, /起動しています/);
    assert.equal(installGuidance({ ...state, offered: true }).hideButton, true);
  }
  assert.match(installGuidance({ installed: true }).message, /追加が完了/);
  assert.doesNotMatch(installGuidance({ installed: true }).message, /起動しています/);
  assert.equal(installGuidance({ offered: true }).hideButton, false);
  assert.equal(installGuidance({ legacyStandalone: "true" }).hideButton, true);
  assert.doesNotMatch(installGuidance({ legacyStandalone: "true" }).message, /起動しています/);
});
