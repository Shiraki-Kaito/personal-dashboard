import test from "node:test";
import assert from "node:assert/strict";
import { digest, extractAppointment } from "../src/agenda-rules.js";
import {
  readTimingConfirmation,
  saveTimingConfirmation,
} from "../src/timing-confirmations.js";
import { timingCalendarSeed } from "../src/timing-calendar.js";
import {
  previewAppointment,
  registerAppointment,
  reconcileAppointment,
} from "../src/agenda.js";
import {
  createAgendaBackup,
  agendaRestoreEntries,
} from "../src/agenda-backup.js";
const env = {};
function memory(values = new Map()) {
  let tail = Promise.resolve();
  const s = {
    values,
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    list: async ({ prefix }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
    transaction(fn) {
      const result = tail.then(() => fn(s));
      tail = result.catch(() => {});
      return result;
    },
  };
  return s;
}
async function setup() {
  const s = memory(),
    accounts = await Promise.all(
      ["a", "b", "c", "d"].map(async (name) => ({
        id: await digest(name + "@example.test"),
        email: name + "@example.test",
        calendar: "primary",
      })),
    );
  await s.put("agenda:accounts", accounts);
  for (let i = 0; i < accounts.length; i++)
    await s.put("agenda:credential:" + accounts[i].id, {
      token: "fixture-" + i,
      expires: Date.now() + 3600000,
    });
  const message = {
    id: "abc",
    subject: "面接案内",
    from: "jobs@example.test",
    excerpt: "面接日時：11月20日 10:00。提出期限：11月21日",
    receivedAt: "2026-11-14T01:00:00Z",
  };
  message.candidate = extractAppointment(message.subject, message.excerpt);
  await s.put("agenda:cache:" + accounts[0].id, { messages: [message] });
  const source = (
    await readTimingConfirmation(s, {
      accountId: accounts[0].id,
      messageId: "abc",
    })
  ).timings[0];
  const confirm = {
    accountId: accounts[0].id,
    messageId: "abc",
    timingId: source.timingId,
    sourceRevision: source.sourceRevision,
    expectedRevision: source.revision,
    confirm: true,
    value: {
      kind: "event",
      action: "面接",
      date: "2026-11-20",
      time: "10:00",
      endDate: "2026-11-20",
      endTime: "11:00",
    },
  };
  const saved = (await saveTimingConfirmation(s, confirm)).timings[0];
  const ref = {
    messageId: "abc",
    timingId: saved.timingId,
    sourceRevision: saved.sourceRevision,
    revision: saved.revision,
  };
  const seed = await timingCalendarSeed(s, {
    accountId: accounts[0].id,
    timingRef: ref,
  });
  const base = {
    accountId: accounts[0].id,
    targetAccountId: accounts[1].id,
    messageId: seed.id,
    manual: true,
    timingRef: ref,
    draft: {
      title: seed.candidate.title,
      start: seed.candidate.start,
      end: seed.candidate.end,
      location: "",
    },
  };
  const f = {
    writes: 0,
    events: new Map(),
    inserted: new Map(),
    calls: [],
    pages: false,
    fail: null,
    lostResponse: false,
  };
  f.send = async (url, options = {}) => {
    const u = new URL(url),
      index = Number(options.headers.Authorization.split("fixture-")[1]),
      account = accounts[index];
    f.calls.push({
      accountId: account.id,
      path: u.pathname,
      page: u.searchParams.get("pageToken"),
      method: options.method || "GET",
    });
    if (f.fail === account.id) return Response.json({}, { status: 403 });
    if (u.pathname.endsWith("/events") && options.method === "POST") {
      f.writes++;
      if (f.duringInsert) await f.duringInsert();
      const event = {
        ...JSON.parse(options.body),
        htmlLink: "https://www.google.com/calendar/event?eid=fixture",
      };
      f.inserted.set(account.id + ":" + event.id, event);
      if (f.lostResponse) throw Error("fixture response lost");
      return Response.json(event);
    }
    if (u.pathname.endsWith("/events"))
      return Response.json({
        kind: "calendar#events",
        timeZone: "Asia/Tokyo",
        items:
          f.pages && !u.searchParams.get("pageToken")
            ? []
            : f.events.get(account.id) || [],
        ...(f.pages && !u.searchParams.get("pageToken")
          ? { nextPageToken: "next" }
          : {}),
      });
    if (f.beforeReservation) {
      const fn = f.beforeReservation;
      f.beforeReservation = null;
      await fn();
    }
    const id = u.pathname.split("/").at(-1),
      event = f.inserted.get(account.id + ":" + id);
    return event ? Response.json(event) : Response.json({}, { status: 404 });
  };
  return { s, accounts, confirm, saved, seed, base, f };
}
const collision = (title = "別の予定") => ({
  id: "existing",
  etag: "1",
  summary: title,
  start: { dateTime: "2026-11-20T10:00:00+09:00" },
  end: { dateTime: "2026-11-20T11:00:00+09:00" },
});
test("確定した開始・終了を引き継ぎ、4アカウントを全ページ照合して登録後に再取得する", async () => {
  const { s, accounts, base, f, seed } = await setup();
  assert.equal(seed.candidate.start, "2026-11-20T10:00");
  f.pages = true;
  const preview = await previewAppointment(env, s, base, f.send);
  assert.deepEqual(
    preview.checkedAccountIds,
    [...accounts.map((a) => a.id)].sort(),
  );
  assert.equal(f.calls.filter((c) => c.path.endsWith("/events")).length, 8);
  const view = await registerAppointment(
    env,
    s,
    { ...base, checksum: preview.checksum, confirmed: true },
    f.send,
  );
  assert.equal(view.manualRegistrations[0].phase, "登録確認済み");
  assert.equal(f.writes, 1);
  const event = [...f.inserted.values()][0];
  assert.equal(event.visibility, "private");
  assert.equal(event.attendees, undefined);
  assert.equal(
    view.manualRegistrations[0].timingRef.revision,
    base.timingRef.revision,
  );
});
test("別アカウントの重複は承認でも登録不可、時間競合は明示確認なしなら停止", async () => {
  const { s, accounts, base, f } = await setup();
  f.events.set(accounts[2].id, [collision("面接")]);
  const p = await previewAppointment(env, s, base, f.send);
  assert.equal(p.matches[0].accountId, accounts[2].id);
  assert.equal(p.matches[0].duplicate, true);
  await assert.rejects(
    registerAppointment(
      env,
      s,
      { ...base, checksum: p.checksum, confirmed: true, allowConflict: true },
      f.send,
    ),
    /同じ日時/,
  );
  f.events.set(accounts[2].id, [collision()]);
  const conflict = await previewAppointment(env, s, base, f.send);
  await assert.rejects(
    registerAppointment(
      env,
      s,
      { ...base, checksum: conflict.checksum, confirmed: true },
      f.send,
    ),
    /重なる予定/,
  );
  assert.equal(f.writes, 0);
  assert.equal(
    (
      await registerAppointment(
        env,
        s,
        {
          ...base,
          checksum: conflict.checksum,
          confirmed: true,
          allowConflict: true,
        },
        f.send,
      )
    ).manualRegistrations[0].phase,
    "登録確認済み",
  );
});
test("日時の再編集・確定解除・ドラフトの日時ずれは書き込み前に拒否する", async () => {
  const { s, base, confirm, saved, f } = await setup();
  const p = await previewAppointment(env, s, base, f.send);
  await assert.rejects(
    previewAppointment(
      env,
      s,
      { ...base, draft: { ...base.draft, start: "2026-11-20T10:30" } },
      f.send,
    ),
    /本人確定内容/,
  );
  await saveTimingConfirmation(s, {
    ...confirm,
    expectedRevision: saved.revision,
    reset: true,
  });
  await assert.rejects(
    registerAppointment(
      env,
      s,
      { ...base, checksum: p.checksum, confirmed: true },
      f.send,
    ),
    /変更・解除/,
  );
  assert.equal(f.writes, 0);
});
test("照合後の新しい予定・権限エラーでは登録を停止する", async () => {
  const { s, accounts, base, f } = await setup();
  const p = await previewAppointment(env, s, base, f.send);
  f.events.set(accounts[3].id, [collision()]);
  await assert.rejects(
    registerAppointment(
      env,
      s,
      { ...base, checksum: p.checksum, confirmed: true },
      f.send,
    ),
    /予定が変わりました/,
  );
  f.fail = accounts[3].id;
  await assert.rejects(previewAppointment(env, s, base, f.send));
  assert.equal(f.writes, 0);
});
test("登録予約直前の日時変更を検知し、予約後は結果不明中の日時変更を拒否する", async () => {
  const { s, base, confirm, saved, f } = await setup();
  const p = await previewAppointment(env, s, base, f.send);
  f.beforeReservation = () =>
    saveTimingConfirmation(s, {
      ...confirm,
      expectedRevision: saved.revision,
      value: { ...confirm.value, time: "09:00" },
    });
  await assert.rejects(
    registerAppointment(
      env,
      s,
      { ...base, checksum: p.checksum, confirmed: true },
      f.send,
    ),
    /変更・解除/,
  );
  assert.equal(f.writes, 0);
  const second = await setup(),
    next = await previewAppointment(env, second.s, second.base, second.f.send);
  second.f.duringInsert = () =>
    assert.rejects(
      saveTimingConfirmation(second.s, {
        ...second.confirm,
        expectedRevision: second.saved.revision,
        reset: true,
      }),
      /登録結果が未確認/,
    );
  await registerAppointment(
    env,
    second.s,
    { ...second.base, checksum: next.checksum, confirmed: true },
    second.f.send,
  );
  assert.equal(second.f.writes, 1);
});
test("応答喪失後は再送せず再照合し、バックアップ復元後も登録済みIDを保持する", async () => {
  const { s, accounts, base, f } = await setup(),
    p = await previewAppointment(env, s, base, f.send);
  f.lostResponse = true;
  await registerAppointment(
    env,
    s,
    { ...base, checksum: p.checksum, confirmed: true },
    f.send,
  );
  assert.equal((await s.get("agenda:pending:" + base.accountId)).length, 1);
  await assert.rejects(
    registerAppointment(
      env,
      s,
      { ...base, checksum: p.checksum, confirmed: true },
      f.send,
    ),
    /二重登録/,
  );
  const target = memory();
  await target.put("agenda:accounts", accounts);
  const backup = await createAgendaBackup(s),
    plan = await agendaRestoreEntries(target, backup);
  for (const [key, value] of plan.entries) await target.put(key, value);
  for (let i = 0; i < accounts.length; i++)
    await target.put("agenda:credential:" + accounts[i].id, {
      token: "fixture-" + i,
      expires: Date.now() + 3600000,
    });
  const view = await reconcileAppointment(env, target, base, f.send);
  assert.equal(view.manualRegistrations[0].phase, "登録確認済み");
  assert.equal(f.writes, 1);
});
test("同じ確定日時の並行登録を1件だけに絞り、再編集でも登録済みIDを使う", async () => {
  const { s, base, f, confirm, saved } = await setup(),
    p = await previewAppointment(env, s, base, f.send);
  const input = { ...base, checksum: p.checksum, confirmed: true };
  const result = await Promise.allSettled([
    registerAppointment(env, s, input, f.send),
    registerAppointment(env, s, input, f.send),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.writes, 1);
  await saveTimingConfirmation(s, {
    ...confirm,
    expectedRevision: saved.revision,
    value: { ...confirm.value, time: "12:00", endTime: "13:00" },
  });
  const timing = (await readTimingConfirmation(s, confirm)).timings[0];
  const seed = await timingCalendarSeed(s, {
    accountId: base.accountId,
    timingRef: { ...base.timingRef, revision: timing.revision },
  });
  assert.equal(seed.id, base.messageId);
  assert.equal(seed.operation.phase, "登録確認済み");
});

test("同じメールの別の確定日時には別IDを使い、時刻なしの締切を勝手に補完しない", async () => {
  const { s, base } = await setup();
  const other = (
    await readTimingConfirmation(s, {
      accountId: base.accountId,
      messageId: "abc",
    })
  ).timings[1];
  const value = {
    kind: "deadline",
    action: "書類提出",
    date: "2026-11-21",
    time: "",
    endDate: "",
    endTime: "",
  };
  const saved = (
    await saveTimingConfirmation(s, {
      accountId: base.accountId,
      messageId: "abc",
      timingId: other.timingId,
      sourceRevision: other.sourceRevision,
      expectedRevision: other.revision,
      value,
      confirm: true,
    })
  ).timings[1];
  const seed = await timingCalendarSeed(s, {
    accountId: base.accountId,
    timingRef: {
      messageId: "abc",
      timingId: saved.timingId,
      sourceRevision: saved.sourceRevision,
      revision: saved.revision,
    },
  });
  assert.notEqual(seed.id, base.messageId);
  assert.equal(seed.candidate.start, "");
  assert.equal(seed.candidate.end, "");
});
