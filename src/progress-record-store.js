import { InputError } from "./sync.js";

const prefix = "drive:progress:record:";
const chunkBytes = 96 * 1024;
export const maximumReportBytes = 2 * 1024 * 1024;

async function digest(bytes) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

// 呼び出し側のtransaction内で本文と索引を一緒に確定する。
export async function writeReportRecord(storage, record) {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (bytes.length > maximumReportBytes)
    throw new InputError(
      "報告の保存上限2MiBを超えました。資料・期間を絞ってください。前の履歴は保持しています",
    );
  const key = prefix + record.id;
  const previous = await storage.get(key);
  const count = Math.ceil(bytes.length / chunkBytes);
  for (let index = 0; index < count; index++)
    await storage.put(
      key + ":part:" + index,
      bytes.slice(index * chunkBytes, (index + 1) * chunkBytes),
    );
  await storage.put(key, {
    format: "chunks-v1",
    count,
    bytes: bytes.length,
    digest: await digest(bytes),
  });
  if (previous?.format === "chunks-v1")
    for (let index = count; index < previous.count; index++)
      await storage.delete(key + ":part:" + index);
}

export async function readReportRecord(storage, id) {
  const key = prefix + id;
  const manifest = await storage.get(key);
  if (!manifest || manifest.format !== "chunks-v1") return manifest;
  if (
    !Number.isSafeInteger(manifest.count) ||
    manifest.count < 1 ||
    manifest.count > Math.ceil(maximumReportBytes / chunkBytes) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.bytes > maximumReportBytes
  )
    throw new InputError("報告の保存状態が不正です。復元元を確認してください");
  const joined = new Uint8Array(manifest.bytes);
  let offset = 0;
  for (let index = 0; index < manifest.count; index++) {
    const part = await storage.get(key + ":part:" + index);
    const expected = Math.min(chunkBytes, manifest.bytes - offset);
    if (
      !(part instanceof Uint8Array) ||
      part.length !== expected ||
      expected <= 0
    )
      throw new InputError(
        "報告の保存内容が不足しています。部分的な報告は表示しません",
      );
    joined.set(part, offset);
    offset += part.length;
  }
  if (offset !== manifest.bytes)
    throw new InputError("報告の保存内容が不足しています");
  if (manifest.digest && manifest.digest !== (await digest(joined)))
    throw new InputError(
      "報告の保存内容が一致しません。復元元を確認してください",
    );
  const record = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(joined),
  );
  if (record.id !== id) throw new InputError("報告の保存先が一致しません");
  return record;
}
