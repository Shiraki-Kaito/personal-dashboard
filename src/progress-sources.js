import { InputError } from "./sync.js";
import { isPersonalWork } from "./drive-review.js";
import {
  driveToken,
  ensureDriveAccount,
  minutesReadScope,
  sheetsReadScope,
} from "./drive-auth.js";
import { readDocument, documentJson, documentFields } from "./weekly-drive.js";
import { documentFacts, spreadsheetFacts } from "./progress-evidence.js";

export const maximumReportSources = 12;
const docsMime = "application/vnd.google-apps.document",
  sheetsMime = "application/vnd.google-apps.spreadsheet";
const maximumSheets = 10,
  maximumSheetRows = 1000,
  maximumSheetColumns = 32,
  maximumCells = 32000;
export function reportSourceCatalog(cache) {
  return (cache?.files || [])
    .filter(
      (file) => !isPersonalWork(file) && !/_L\.md$/i.test(file.name || ""),
    )
    .map((file) => ({
      id: file.id,
      name: file.name,
      folder: file.folder,
      modifiedTime: file.modifiedTime,
      mimeType: file.mimeType,
      supported: [docsMime, sheetsMime].includes(file.mimeType),
    }))
    .map((file) => ({
      ...file,
      recommended:
        file.supported &&
        /議事録|MTG|Meeting|週間.*レポート|月間.*レポート/i.test(file.name),
      suggestedRole: /Organizer|OOMTG/i.test(file.name)
        ? "organizer"
        : /全体定例/.test(file.name)
          ? "plenary"
          : /議事録|MTG|Meeting/i.test(file.name)
            ? "personal"
            : "work",
    }))
    .sort((a, b) => (b.modifiedTime || "").localeCompare(a.modifiedTime || ""));
}
export function reportTeams(cache) {
  const root =
    cache.folderName || (cache.files || [])[0]?.folder?.split(" / ")[0];
  if (!root) return [];
  const paths = [
    ...new Set(
      (cache.files || [])
        .filter((file) => !isPersonalWork(file))
        .map((file) => (file.folder || "").split(" / ").slice(0, 2).join(" / "))
        .filter(Boolean),
    ),
  ];
  return [
    { path: root, name: root.replace(/^\d+[_\s-]*/, "") },
    ...paths
      .filter(
        (path) =>
          path !== root && /\/(?:\s*)(?:100|200|300|400)[_\s-]/.test(path),
      )
      .map((path) => ({
        path,
        name: path
          .split(" / ")
          .at(-1)
          .replace(/^\d+[_\s-]*/, ""),
      })),
  ];
}
export function expandReportSources(catalog, request) {
  const selected = new Map();
  for (const input of request.sources) {
    const file = catalog.find((file) => file.id === input.id);
    if (
      !file ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(file.id) ||
      !["personal", "organizer", "plenary", "work"].includes(input.role)
    )
      throw new InputError(
        "参照資料が取得範囲外か、用途が不正です。資料一覧を再取得してください",
      );
    if (selected.has(file.id)) throw new InputError("参照資料が重複しています");
    selected.set(file.id, { ...file, role: input.role });
  }
  for (const folder of request.folders) {
    if (
      !catalog.some(
        (file) =>
          file.folder === folder || file.folder.startsWith(folder + " / "),
      )
    )
      throw new InputError("参照フォルダが取得範囲外です");
    for (const file of catalog.filter(
      (file) =>
        file.folder === folder || file.folder.startsWith(folder + " / "),
    ))
      if (!selected.has(file.id))
        selected.set(file.id, { ...file, role: file.suggestedRole || "work" });
  }
  if (!selected.size || selected.size > maximumReportSources)
    throw new InputError(
      `一度に読む資料は1〜${maximumReportSources}件です。資料またはフォルダを絞ってください。省略して全件扱いにはしません`,
    );
  return [...selected.values()];
}
async function readJson(url, token, send) {
  const response = await readDocument(url, token, send);
  if (!response.ok) {
    await response.body?.cancel();
    const messages = {
      401: "Googleへの再認可が必要です",
      403: "APIの有効化・閲覧権限・読み取り認可を確認してください",
      404: "資料が見つからないか閲覧権限がありません",
      429: "利用制限です。時間を置いて再取得してください",
    };
    throw new InputError(
      messages[response.status] || "資料を取得できませんでした",
    );
  }
  return documentJson(response);
}
async function readSheet(file, token, send) {
  const base = "https://sheets.googleapis.com/v4/spreadsheets/" + file.id;
  const metadata = await readJson(
    base +
      "?fields=spreadsheetId,sheets(properties(sheetId,title,gridProperties))",
    token,
    send,
  );
  if (metadata.spreadsheetId !== file.id || !Array.isArray(metadata.sheets))
    throw new InputError("シートの取得元・形式が不正です");
  if (metadata.sheets.length > maximumSheets)
    throw new InputError(
      "シート数が10を超えています。部分取得で作成せず停止しました",
    );
  const eligible = metadata.sheets.filter(
    (sheet) =>
      !/^(archive|old|template|過去|テンプレート)$/i.test(
        sheet.properties?.title || "",
      ),
  );
  let cells = 0;
  const checks = [];
  const url = new URL(base + "/values:batchGet");
  for (const sheet of eligible) {
    const props = sheet.properties,
      grid = props.gridProperties;
    if (
      !grid ||
      !Number.isSafeInteger(grid.rowCount) ||
      !Number.isSafeInteger(grid.columnCount)
    )
      throw new InputError("シートの読み取り範囲を確認できません");
    const rows = Math.min(grid.rowCount, maximumSheetRows),
      columns = Math.min(grid.columnCount, maximumSheetColumns);
    cells += rows * columns;
    if (cells > maximumCells)
      throw new InputError(
        "シートの読み取り上限32000セルを超えます。省略せず停止しました",
      );
    const column =
      columns > 26
        ? "A" + String.fromCharCode(64 + columns - 26)
        : String.fromCharCode(64 + columns);
    url.searchParams.append(
      "ranges",
      "'" + props.title.replaceAll("'", "''") + "'!A1:" + column + rows,
    );
    if (grid.rowCount > rows || grid.columnCount > columns)
      checks.push({
        sourceId: file.id,
        message: `${props.title}はA1:${column}${rows}だけを読みました。範囲外は未取得です`,
      });
  }
  if (!eligible.length)
    return {
      sheets: [],
      checks: [{ sourceId: file.id, message: "対象のシートがありません" }],
    };
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  const values = await readJson(url, token, send);
  if (
    values.spreadsheetId !== file.id ||
    values.valueRanges?.length !== eligible.length
  )
    throw new InputError("シートの読み取り結果が不足しています");
  return {
    sheets: eligible.map((sheet, index) => ({
      title: sheet.properties.title,
      id: sheet.properties.sheetId,
      values: values.valueRanges[index].values || [],
    })),
    checks,
  };
}
export async function readProgressSources(
  env,
  storage,
  files,
  reporter,
  send = fetch,
) {
  const credential = await storage.get("drive:credential");
  const readable = files.some(
    (file) =>
      file.supported &&
      credential?.scopes?.includes(
        file.mimeType === docsMime ? minutesReadScope : sheetsReadScope,
      ),
  );
  const token = readable ? await driveToken(env, storage, send) : null;
  if (token) await ensureDriveAccount(storage, token, send);
  const sources = [];
  for (const file of files) {
    let result;
    try {
      if (!file.supported)
        throw new InputError(
          "本文未対応の形式です。更新日時だけで実績は作りません",
        );
      const scope =
        file.mimeType === docsMime ? minutesReadScope : sheetsReadScope;
      if (!credential?.scopes?.includes(scope))
        throw new InputError(
          file.mimeType === docsMime
            ? "Google Docsの読み取り追加認可が必要です"
            : "Google Sheetsの読み取り追加認可が必要です",
        );
      if (file.mimeType === docsMime) {
        const url = new URL(
          "https://docs.googleapis.com/v1/documents/" + file.id,
        );
        url.search = new URLSearchParams({
          includeTabsContent: "true",
          suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
          fields: documentFields,
        });
        const document = await readJson(url, token, send);
        if (document.documentId !== file.id)
          throw new InputError("文書の取得元が一致しません");
        result = {
          ...documentFacts(document, file, reporter),
          revision: document.revisionId || null,
        };
      } else {
        const sheet = await readSheet(file, token, send);
        result = spreadsheetFacts(sheet.sheets, file, reporter);
        result.checks.push(...sheet.checks);
      }
      sources.push({ ...file, ...result, status: "read" });
    } catch (error) {
      sources.push({
        ...file,
        status: "unread",
        facts: [],
        dates: [],
        checks: [
          {
            sourceId: file.id,
            message:
              error instanceof InputError || error.code
                ? error.message
                : "資料の読み取りを完了できませんでした",
          },
        ],
      });
    }
  }
  return sources;
}
