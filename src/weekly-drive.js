import { InputError } from "./sync.js";
import {
  driveToken,
  minutesReadScope,
  ensureDriveAccount,
} from "./drive-auth.js";
import { googleRequest } from "./drive-http.js";
import { isPersonalWork } from "./drive-review.js";
import { weeklyEvidence, composeWeeklyReports } from "./weekly-report.js";
const key = "drive:weeklySettings";
const maximumDocumentBytes = 2 * 1024 * 1024;
// 本文・日付チップ・リスト階層だけを取得し、画像や全書式の大きな応答を避ける。
export const documentFields = "documentId,title,revisionId,tabs(tabProperties(tabId,title),documentTab(body(content(startIndex,paragraph(elements(textRun(content),dateElement(dateElementProperties(timestamp,displayText))),bullet(nestingLevel),paragraphStyle(namedStyleType)),table(tableRows(tableCells(content)))))),childTabs)";
const readRetryDelayMs = 1000;
export async function readDocument(url, token, send) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await googleRequest(
        url,
        { headers: { Authorization: "Bearer " + token } },
        send,
      );
      if (response.status < 500 || attempt === 1) return response;
      await response.body?.cancel();
    } catch (error) {
      if (error.code !== "network" || attempt === 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, readRetryDelayMs));
  }
}
export function normalizeWeeklySettings(value) {
  if (
    !value ||
    typeof value.scope !== "string" ||
    !value.scope ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.minutesId) ||
    typeof value.ownerName !== "string" ||
    !value.ownerName.trim() ||
    value.ownerName.length > 40 ||
    /[\u0000-\u001f\u007f]/.test(value.ownerName) ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.revision)
  )
    throw new InputError("週報の参照元・本人表記の設定が不正です");
  return {
    scope: value.scope,
    minutesId: value.minutesId,
    ownerName: value.ownerName.trim(),
    revision: value.revision,
  };
}
export function minutesSources(cache) {
  return (cache?.files || [])
    .filter(
      (file) =>
        file.mimeType === "application/vnd.google-apps.document" &&
        !isPersonalWork(file) &&
        !/_L\.md$/i.test(file.name || ""),
    )
    .map((file) => ({ id: file.id, name: file.name, folder: file.folder }));
}
export async function configureWeekly(storage, scope, input) {
  const candidate = normalizeWeeklySettings({
    ...input,
    scope,
    revision: crypto.randomUUID(),
  });
  if (
    input.scope !== scope ||
    !(
      input.expectedRevision === null ||
      typeof input.expectedRevision === "string"
    )
  )
    throw new InputError("週報の設定版を再取得してください");
  return storage.transaction(async (tx) => {
    const cache = await tx.get("drive:cache"),
      previous = await tx.get(key);
    if (
      cache?.scope !== scope ||
      !minutesSources(cache).some((file) => file.id === candidate.minutesId)
    )
      throw new InputError(
        "取得済みの対象フォルダ内のGoogleドキュメントを選択してください",
      );
    if (previous && previous.scope !== scope)
      throw new InputError("別のDrive接続範囲の週報設定が残っています");
    if ((previous?.revision || null) !== input.expectedRevision)
      throw new InputError(
        "別の画面で週報の参照設定が変更されました。再取得してください",
      );
    await tx.put(key, candidate);
    return candidate;
  });
}
export async function documentJson(response) {
  const reader = response.body.getReader();
  let length = 0,
    parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumDocumentBytes) {
        await reader.cancel();
        throw new InputError(
          "議事録が2MiBの読み取り上限を超えています。部分取得で下書きを作らず停止しました",
        );
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InputError(
      "議事録本文の応答が不正です。下書きは更新していません",
    );
  }
}
export async function generateWeekly(env, storage, scope, input, send = fetch) {
  const settings = normalizeWeeklySettings(await storage.get(key));
  if (settings.scope !== scope || settings.revision !== input.settingsRevision)
    throw new InputError("週報の設定が変わりました。再取得してください");
  const cache = await storage.get("drive:cache");
  if (
    cache?.scope !== scope ||
    !minutesSources(cache).some((file) => file.id === settings.minutesId)
  )
    throw new InputError(
      "参照元を対象フォルダ内で確認できません。Driveを再取得してください",
    );
  const credential = await storage.get("drive:credential");
  if (!credential?.scopes?.includes(minutesReadScope))
    throw new InputError(
      "議事録本文を読み取る追加認可が必要です。元の議事録への書き込み権限は要求しません",
    );
  try {
    const token = await driveToken(env, storage, send);
    await ensureDriveAccount(storage, token, send);
    const url = new URL(
      "https://docs.googleapis.com/v1/documents/" + settings.minutesId,
    );
    url.search = new URLSearchParams({
      includeTabsContent: "true",
      suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
      fields: documentFields,
    });
    const response = await readDocument(url, token, send);
    if (response.status === 403)
      throw new InputError(
        "議事録を読めません。Google Docs APIの有効化と、このアカウントの閲覧権限・追加認可を確認してください",
      );
    if (response.status === 401)
      throw new InputError(
        "Googleへの再認可が必要です。前の下書きは保持しています",
      );
    if (response.status === 404)
      throw new InputError("議事録が見つからないか、閲覧権限がありません");
    if (response.status === 429)
      throw new InputError(
        "Google Docs APIの利用制限です。時間を置いて再取得してください",
      );
    if (!response.ok)
      throw new InputError(
        "議事録の取得に失敗しました。前の下書きは保持しています",
      );
    const document = await documentJson(response);
    if (document.documentId !== settings.minutesId)
      throw new InputError("議事録の取得元が一致しません");
    const evidence = weeklyEvidence(cache, document, {
      endDate: input.endDate,
      ownerName: settings.ownerName,
    });
    const latest = await storage.get(key);
    if (latest?.revision !== settings.revision)
      throw new InputError(
        "取得中に週報の設定が変わりました。再取得してください",
      );
    return {
      reports: composeWeeklyReports(evidence),
      evidence,
      source: {
        id: document.documentId,
        title: document.title,
        revision: document.revisionId || null,
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(
      error.code
        ? error.message
        : "議事録の読み取りに失敗しました。前の下書きは保持しています",
    );
  }
}
