// 通知状態はDOの直列処理内で更新する。本文やアカウント識別子を受け取らない。
const storeKey = 'security:monitor';
const minute = 60_000;
const windowMs = 5 * minute;
const cooldownMs = 24 * 60 * minute;
const retentionMs = 7 * cooldownMs;
const deliveryTimeoutMs = 8_000;
const rules = {
  denied: {threshold:20, label:'認証・認可の拒否が増加しています'},
  volume: {threshold:300, label:'APIの取得回数が増加しています'},
  server: {threshold:5, label:'サーバーエラーが続いています'},
  scheduled: {threshold:1, label:'定期処理に失敗しました'},
  test: {threshold:1, label:'通知経路の検証です'},
};
async function load(storage, now) {
  const state = await storage.get(storeKey) || {buckets:{},alerts:[]};
  state.alerts = state.alerts.filter(item => now-item.createdAt < retentionMs);
  return state;
}
export async function recordMonitorSignal(storage, kind, now = Date.now()) {
  if (!Object.hasOwn(rules,kind)) throw new Error('Unknown monitoring signal');
  const state = await load(storage,now);
  const bucket = state.buckets[kind];
  const current = !bucket || bucket.until <= now ? {until:now+windowMs,count:0} : bucket;
  current.count = Math.min(current.count+1,rules[kind].threshold);
  state.buckets[kind] = current;
  if (current.count >= rules[kind].threshold && !state.alerts.some(item=>item.kind===kind && now-item.createdAt<cooldownMs)) {
    state.alerts.push({id:crypto.randomUUID(),kind,createdAt:now,status:'pending',attempts:0,nextAt:now});
    state.alerts = state.alerts.slice(-40);
  }
  await storage.put(storeKey,state);
}
export async function observeResponse(storage, path, status, method, now = Date.now()) {
  const protectedPath = path.startsWith('/api/') || path === '/auth/callback' || path === '/auth/login';
  if (!protectedPath) return;
  if ([401,403,429].includes(status)) await recordMonitorSignal(storage,'denied',now);
  if (status >= 500) await recordMonitorSignal(storage,'server',now);
  if (path.startsWith('/api/') && method === 'GET' && status === 200) await recordMonitorSignal(storage,'volume',now);
}
function configured(env) {
  const address = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
  return env.SECURITY_ALERTS_ENABLED === 'true' && typeof env.SECURITY_EMAIL?.send === 'function' && address(env.SECURITY_ALERT_FROM) && address(env.SECURITY_ALERT_TO);
}
export async function monitoringView(env,storage,now=Date.now()) {
  const state = await load(storage,now);
  return {configured:configured(env),alerts:state.alerts.map(item=>({...item,label:rules[item.kind].label})),
    limits:'5分で認証拒否20回・取得300回・サーバーエラー5回、定期処理失敗1回。同種通知は24時間に1件（暫定）。'};
}
export async function deliverSecurityAlert(env,storage,now=Date.now()) {
  const state = await load(storage,now);
  // 無通知設定でも毎時掃除し、期限を過ぎた警告を残し続けない。
  await storage.put(storeKey,state);
  if (!configured(env)) return;
  const alert = state.alerts.find(item=>item.status==='pending' && item.nextAt<=now);
  if (!alert) return;
  // 外部送信の直前に結果不明を保存。再起動・応答消失で無条件に再送しない。
  alert.status='unknown'; alert.attempts++; alert.lastAttempt=now;
  await storage.put(storeKey,state);
  let timer;
  try {
    const result = await Promise.race([
      env.SECURITY_EMAIL.send({from:env.SECURITY_ALERT_FROM,to:env.SECURITY_ALERT_TO,
        subject:'personal-dashboard: セキュリティ・障害通知',
        text:`${rules[alert.kind].label}\n検知日時: ${new Date(alert.createdAt).toISOString()}\n通知ID: ${alert.id}\n本人用サイトの接続と設定から状況を確認してください。\nこれは到達確認済みを意味しません。`}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),deliveryTimeoutMs);}),
    ]);
    if (typeof result?.messageId === 'string' && result.messageId.length) {
      alert.status='accepted'; alert.acceptedAt=now;
    }
  } catch(error) {
    // 明示された受付前の制限だけ再試行する。生エラーに宛先・秘密が含まれる可能性があるため保存しない。
    if (['E_RATE_LIMIT_EXCEEDED','E_DAILY_LIMIT_EXCEEDED','E_EMAIL_SENDING_NOT_READY'].includes(error?.code)) {
      alert.status=alert.attempts<3 ? 'pending' : 'failed';
      alert.nextAt=now + (2 ** (alert.attempts-1)) * 60 * minute;
    }
  } finally { clearTimeout(timer); }
  await storage.put(storeKey,state);
}
