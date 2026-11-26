export const maximumRequestBytes = 10 * 1024 * 1024; // 8MiBバックアップ＋JSON包みの余裕。運用で再計測する暫定値。
export class RequestBoundaryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function readRequestJson(request, limit = maximumRequestBytes, timeoutMs = 10000) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new RequestBoundaryError(413, '入力容量の上限を超えています');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBoundaryError(400, 'JSON入力が必要です');
  const chunks = []; let bytes = 0, timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new RequestBoundaryError(408, '入力の受信がタイムアウトしました')), timeoutMs); });
  try {
    while (true) {
      const {done,value} = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new RequestBoundaryError(413, '入力容量の上限を超えています');
      chunks.push(value);
    }
    const all = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { all.set(chunk,offset); offset += chunk.byteLength; }
    const result = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof RequestBoundaryError) throw error;
    throw new RequestBoundaryError(400, 'JSON入力が不正です');
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
// Durable Objectの直列処理内で利用。本人API120回/分は暫定の回復可能な上限。
export async function allowRequest(storage, key, maximum, now = Date.now()) {
  const previous = await storage.get('security:rate:' + key);
  const current = !previous || previous.until <= now ? {until:now+60000,count:0} : previous;
  if (current.count >= maximum) return false;
  await storage.put('security:rate:' + key, {...current,count:current.count+1});
  return true;
}

export async function recordSecurityEvent(storage, event, now = Date.now()) {
  const retentionMs = 7 * 24 * 60 * 60 * 1000;
  const previous = (await storage.get('security:audit')) || [];
  // 本文・URLパラメーター・Cookie・IP・メールは受け取らない。
  const entries = previous.filter(item=>item.at > now-retentionMs).slice(-99);
  entries.push({at:now,route:event.route,status:event.status,method:event.method});
  await storage.put('security:audit',entries);
}

export async function allowLoginRequest(request, storage, now = Date.now()) {
  // CF-Connecting-IPはCloudflare配信境界が付与する値だけを利用。X-Forwarded-Forは使わない。
  const source = (request.headers.get('CF-Connecting-IP') || 'unavailable').slice(0,64);
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  const key = Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  const records = ((await storage.get('security:login-sources')) || []).filter(item=>item.until>now);
  let record = records.find(item=>item.key===key);
  if (record?.count >= 5 || !record && records.length >= 128) return false;
  if (!await allowRequest(storage,'login-total',60,now)) return false;
  if (record) record.count++;
  else records.push({key,count:1,until:now+60000});
  await storage.put('security:login-sources',records);
  return true;
}

export async function pruneSecurityState(storage, now = Date.now()) {
  const audit = await storage.get('security:audit');
  if (audit) await storage.put('security:audit',audit.filter(item=>item.at>now-7*24*60*60*1000));
  const sources = await storage.get('security:login-sources');
  if (sources) await storage.put('security:login-sources',sources.filter(item=>item.until>now));
  const flow = await storage.get('auth:flow');
  if (flow?.expires <= now) await storage.delete('auth:flow');
}
