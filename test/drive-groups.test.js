import test from "node:test";
import assert from "node:assert/strict";
import {
  homeDriveGroups,
  groupView,
  saveDriveGroup,
  defaultGroupColor,
  normalizeGroupStore,
} from "../src/drive-groups.js";
import { createBackup, backupPlan, restoreBackup } from "../src/backup.js";
import { assertBackupEnvelope } from "../public/backup-format.js";
const file = (id, folder) => ({
  id,
  folder,
  name: id,
  mimeType: "text/plain",
  modifiedTime: "2026-11-15T00:00:00Z",
  createdTime: "2026-11-14T00:00:00Z",
  lastModifiedBy: "担当者",
});
function memory() {
  const data = new Map([
    [
      "drive:cache",
      {
        scope: "root:true",
        files: [
          file("a", "チーム / SNS / 投稿"),
          file("b", "チーム / LP"),
          file("private", "チーム / SNS / 個人作業"),
        ],
        unreadChanges: [],
      },
    ],
  ]);
  let pending = Promise.resolve();
  const storage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    list: async ({ prefix }) =>
      new Map([...data].filter(([key]) => key.startsWith(prefix))),
  };
  storage.transaction = (callback) => {
    const result = pending.then(() => callback(storage));
    pending = result.catch(() => {});
    return result;
  };
  return storage;
}
const input = () => ({
  scope: "root:true",
  path: "チーム / SNS",
  expectedRevision: null,
  name: "SNSチーム",
  color: "rose",
  status: "進行中",
  nextAction: "投稿案を確認",
  due: "2026-11-20",
});
test("保存場所で分け、個人作業を除外して更新者を残し、進捗を推測しない", async () => {
  assert.deepEqual(groupView(null, undefined), []);
  const s = memory(),
    groups = groupView(await s.get("drive:cache"));
  assert.equal(groups.length, 2);
  const sns = groups.find((group) => group.path.endsWith("SNS"));
  assert.equal(sns.recent.length, 1);
  assert.equal(sns.recent[0].lastModifiedBy, "担当者");
  assert.equal(sns.status, "未設定");
  assert.equal(sns.color, defaultGroupColor(sns.path));
});
test("色・表示名・進捗を保存し、再読込と範囲外移動後も記録を保持する", async () => {
  const s = memory();
  await saveDriveGroup(s, input());
  let saved = await s.get("drive:groups");
  let view = groupView(await s.get("drive:cache"), saved).find(
    (group) => group.name === "SNSチーム",
  );
  assert.equal(view.color, "rose");
  assert.equal(view.status, "進行中");
  assert.equal(view.nextAction, "投稿案を確認");
  assert.equal(
    groupView({ scope: "root:true", files: [] }, saved)[0].available,
    false,
  );
  assert.deepEqual(groupView({ scope: "other:true", files: [] }, saved), []);
});
test("二重保存と古いフォームを拒否し、新しいグループ記録を上書きしない", async () => {
  const s = memory();
  const results = await Promise.allSettled([
    saveDriveGroup(s, input()),
    saveDriveGroup(s, input()),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const saved = (await s.get("drive:groups")).records[0];
  await assert.rejects(saveDriveGroup(s, input()), /別の画面/);
  await saveDriveGroup(s, {
    ...input(),
    expectedRevision: saved.revision,
    color: "blue",
  });
  assert.equal((await s.get("drive:groups")).records[0].color, "blue");
});
test("不正な色・日付・過大入力・対象外や個人作業のグループを拒否する", async () => {
  for (const change of [
    { color: "url(evil)" },
    { due: "2026-02-30" },
    { nextAction: "a".repeat(501) },
    { path: "チーム / 不明" },
    { scope: "other:true" },
    { path: "チーム / SNS / 個人作業" },
  ])
    await assert.rejects(saveDriveGroup(memory(), { ...input(), ...change }));
  assert.throws(() =>
    normalizeGroupStore({ scope: "root:true", records: Array(81).fill({}) }),
  );
});
test("バックアップに色と進捗を含め、復元後の旧版保存・既存設定の上書きを防ぐ", async () => {
  const s = memory();
  const members = [{id:crypto.randomUUID(),name:"検証メンバー",role:"リーダー",note:"試験"}];
  await saveDriveGroup(s, {...input(),importantFileIds:["a"],members});
  const env = {
    PROJECT_CONFIG: JSON.stringify({
      projects: [{ project: "p", status_field: "s", due_field: "d" }],
    }),
    DRIVE_CONFIG: JSON.stringify({ folderId: "root", includeSubfolders: true }),
  };
  const backup = await createBackup(env, s);
  assertBackupEnvelope(backup);
  assert.equal(backup.driveGroups.records[0].color, "rose");
  const empty = memory();
  await empty.put("drive:cache", undefined);
  const plan = await backupPlan(env, empty, backup);
  assert.deepEqual(plan.conflicts, []);
  await restoreBackup(env, empty, backup, plan.checksum);
  const restored = await empty.get("drive:groups");
  assert.deepEqual(restored.records[0].importantFileIds,["a"]);
  assert.deepEqual(restored.records[0].members,members);
  assert.notEqual(
    restored.records[0].revision,
    backup.driveGroups.records[0].revision,
  );
  await assert.rejects(
    saveDriveGroup(empty, {
      ...input(),
      expectedRevision: backup.driveGroups.records[0].revision,
    }),
    /別の画面/,
  );
  assert.ok(
    (await backupPlan(env, empty, backup)).conflicts.includes("drive:groups"),
  );
});

test("ホームは番号に依存せず4チームを選び、Driveと同じ色・更新者・版を渡す", () => {
  const groups = [
    {
      path: "Root / 100_SNS運用",
      name: "SNSチーム",
      color: "blue",
      available: true,
      recent: [],
    },
    {
      path: "Root / 200_LP",
      name: "LP",
      color: "violet",
      available: true,
      recent: [],
    },
    {
      path: "Root / 300_コミュニティ連携",
      name: "連携",
      color: "teal",
      available: true,
      recent: [],
    },
    {
      path: "Root / 400_デザイン",
      name: "デザイン",
      color: "rose",
      available: true,
      recent: [],
    },
    {
      path: "Root / 500_クラウドファンディング",
      name: "CF",
      color: "amber",
      available: true,
      recent: [],
    },
  ];
  const update = {
    ...file("sns", "Root / 100_SNS運用 / 投稿"),
    changeId: "version",
    detectedAt: 2,
    events: ["更新"],
  };
  const drive = {
    groups,
    unreadChanges: [
      update,
      { ...file("cf", "Root / 500_クラウドファンディング"), detectedAt: 1 },
    ],
  };
  const before = structuredClone(drive),
    result = homeDriveGroups(drive);
  assert.equal(result.highlighted.length, 4);
  assert.deepEqual(
    result.highlighted.map((group) => group.color),
    ["blue", "violet", "teal", "rose"],
  );
  assert.equal(result.highlighted[0].updates[0].lastModifiedBy, "担当者");
  assert.equal(result.highlighted[0].updates[0].changeId, "version");
  assert.equal(result.others[0].name, "CF");
  assert.equal(result.others[0].pendingCount, 1);
  assert.deepEqual(drive, before);
});
test("ホームの1件上限で残りを明示し、個人作業を分離して全変更を数える", () => {
  const groups = [
    {
      path: "Root / 200_SNS運用",
      name: "SNS",
      color: "blue",
      available: true,
      recent: [],
    },
  ];
  const updates = Array.from({ length: 5 }, (_, i) => ({
    ...file("sns" + i, "Root / 200_SNS運用"),
    detectedAt: i,
  }));
  const result = homeDriveGroups({
    groups,
    unreadChanges: [
      ...updates,
      file("private", "Root / 200_SNS運用 / 個人作業"),
      {
        ...file("moved", "Root / 999_旧フォルダ"),
        events: ["対象範囲外"],
        detectedAt: 1,
      },
    ],
  });
  assert.equal(result.highlighted[0].pendingCount, 5);
  assert.equal(result.highlighted[0].updates.length, 1);
  assert.equal(result.highlighted[0].remaining, 4);
  assert.deepEqual(
    result.highlighted[0].updates.map((file) => file.id),
    ["sns4"],
  );
  assert.equal(
    result.highlighted.reduce((sum, g) => sum + g.pendingCount, 0) +
      result.others.reduce((sum, g) => sum + g.pendingCount, 0),
    6,
  );
  assert.equal(result.others[0].pendingCount, 1);
});
test("未確認なしは直近の更新を区別し、未取得を更新なしや完了と推測しない", () => {
  const recent = file("latest", "Root / 400_デザイン");
  const result = homeDriveGroups({
    groups: [
      {
        path: recent.folder,
        name: "デザイン",
        color: "rose",
        available: true,
        recent: [recent],
      },
    ],
    unreadChanges: [],
  });
  const design = result.highlighted.find((g) => g.key === "design");
  assert.equal(design.latest.id, "latest");
  assert.equal(design.pendingCount, 0);
  assert.deepEqual(design.updates, []);
  const missing = result.highlighted.find((g) => g.key === "lp");
  assert.equal(missing.available, false);
  assert.equal(missing.path, null);
  assert.equal(missing.latest, null);
});

test("チーム番号の変更後も色と版を引き継ぎ、旧フォルダが残る場合は自動統合しない", async () => {
  const s = memory();
  await saveDriveGroup(s, input());
  const saved = await s.get("drive:groups");
  // fixtureのSNS名も本番と同じ意味名に揃える。
  saved.records[0].path = "チーム / 200_SNS運用";
  await s.put("drive:groups", saved);
  const nextCache = {
    scope: "root:true",
    files: [file("a", "チーム / 100_SNS運用")],
    unreadChanges: [],
  };
  await s.put("drive:cache", nextCache);
  const view = groupView(nextCache, saved);
  assert.equal(view.length, 1);
  assert.equal(view[0].color, "rose");
  assert.equal(view[0].path, "チーム / 100_SNS運用");
  assert.equal(view[0].name, "SNSチーム");
  assert.equal(
    groupView(nextCache, {
      ...saved,
      records: [{ ...saved.records[0], name: "200_SNS運用" }],
    })[0].name,
    "100_SNS運用",
  );
  await saveDriveGroup(s, {
    ...input(),
    path: view[0].path,
    expectedRevision: view[0].revision,
    color: "blue",
  });
  assert.equal(
    (await s.get("drive:groups")).records[0].path,
    "チーム / 100_SNS運用",
  );
  const both = groupView(
    {
      ...nextCache,
      files: [...nextCache.files, file("old", "チーム / 200_SNS運用")],
    },
    saved,
  );
  assert.equal(both.length, 2);
  assert.equal(both.find((g) => g.path.endsWith("200_SNS運用")).color, "rose");
});

test("保存した手動進捗・次の対応・期限をホームへ渡し、解除も反映してDriveファイルを保持する", async () => {
  const storage = memory();
  const cache = await storage.get("drive:cache");
  cache.files = [file("sns", "チーム / 100_SNS運用")];
  await storage.put("drive:cache", cache);
  const request = {
    ...input(),
    path: "チーム / 100_SNS運用",
    status: "確認待ち",
    nextAction: "投稿案を確認\n担当者へ共有",
    due: "2026-11-20",
  };
  const saved = await saveDriveGroup(storage, request);
  const project = async () =>
    homeDriveGroups({
      groups: groupView(
        await storage.get("drive:cache"),
        await storage.get("drive:groups"),
      ),
      unreadChanges: [],
    }).highlighted[0];
  const home = await project();
  assert.equal(home.status, request.status);
  assert.equal(home.nextAction, request.nextAction);
  assert.equal(home.due, request.due);
  assert.equal(home.updatedAt, saved.updatedAt);
  assert.equal(home.color, "rose");
  await saveDriveGroup(storage, {
    ...request,
    expectedRevision: saved.revision,
    status: "未設定",
    nextAction: "",
    due: "",
  });
  const cleared = await project();
  assert.equal(cleared.status, "未設定");
  assert.equal(cleared.nextAction, "");
  assert.equal(cleared.due, "");
  assert.equal(cleared.color, "rose");
  assert.deepEqual(await storage.get("drive:cache"), cache);
  const missing = homeDriveGroups({ groups: [], unreadChanges: [] })
    .highlighted[0];
  assert.equal(missing.status, "未設定");
  assert.equal(missing.nextAction, "");
  assert.equal(missing.due, "");
});


test("重要資料は既存の取得範囲から選択し、再取得後もIDで新しい名前と更新者を参照する",async()=>{
 const s=memory();await saveDriveGroup(s,{...input(),importantFileIds:['a','b']});
 let saved=await s.get('drive:groups'),cache=await s.get('drive:cache');
 assert.deepEqual(normalizeGroupStore(saved).records[0].importantFileIds,['a','b']);
 cache.files[0]={...cache.files[0],name:'新しい資料名',lastModifiedBy:'別の担当者'};
 await s.put('drive:cache',cache);
 let group=groupView(cache,saved).find(group=>group.path===input().path);
 assert.equal(group.importantFiles[0].name,'新しい資料名');assert.equal(group.importantFiles[0].lastModifiedBy,'別の担当者');
 await saveDriveGroup(s,{...input(),expectedRevision:group.revision});
 saved=await s.get('drive:groups');assert.deepEqual(saved.records[0].importantFileIds,['a','b'],'旧画面からの保存でも選択を落とさない');
 cache.files=cache.files.filter(file=>file.id!=='a');
 cache.files[0]={...cache.files[0],folder:'チーム / LP / 個人作業'};
 group=groupView(cache,saved).find(group=>group.path===input().path);
 assert.equal(group.importantFiles.every(file=>file.unavailable),true);
 assert.equal(JSON.stringify(group.importantFiles).includes('新しい資料名'),false);
});

test("重要資料の対象外・個人作業・重複・上限超過を拒否し、元の記録を保持する",async()=>{
 const s=memory();
 for(const ids of [['missing'],['private'],['a','a'],['a','b','c','d','e','f'],['https://example.test']]) {
  await assert.rejects(saveDriveGroup(s,{...input(),importantFileIds:ids}));
  assert.equal(await s.get('drive:groups'),undefined);
 }
 const record=await saveDriveGroup(s,{...input(),importantFileIds:['a']});
 await saveDriveGroup(s,{...input(),expectedRevision:record.revision,importantFileIds:[]});
 assert.deepEqual((await s.get('drive:groups')).records[0].importantFileIds,[]);
});

test("重要資料はバックアップの正規化を通り、ホームのチーム情報にも含まれる",async()=>{
 const s=memory();await saveDriveGroup(s,{...input(),path:'チーム / SNS',importantFileIds:['a']});
 const saved=await s.get('drive:groups');
 const restored=normalizeGroupStore(JSON.parse(JSON.stringify(saved)));
 assert.deepEqual(restored.records[0].importantFileIds,['a']);
 const group=groupView(await s.get('drive:cache'),restored).find(group=>group.path===input().path);
 const home=homeDriveGroups({unreadChanges:[],groups:[{...group,path:'Root / 100_SNS運用'}]});
 assert.equal(home.highlighted[0].importantFiles[0].id,'a');
 const legacy=structuredClone(saved);delete legacy.records[0].importantFileIds;
 assert.deepEqual(normalizeGroupStore(legacy).records[0].importantFileIds,[]);
});

test('メンバーの追加・編集・削除、旧画面からの保存、競合を保護する', async () => {
 const s=memory(), member={id:crypto.randomUUID(),name:'試験メンバー',role:'リーダー',note:'担当の確認'};
 const first=await saveDriveGroup(s,{...input(),members:[member]});
 assert.deepEqual(groupView(await s.get('drive:cache'),await s.get('drive:groups')).find(group=>group.path===input().path).members,[member]);
 const legacy=await saveDriveGroup(s,{...input(),expectedRevision:first.revision});
 assert.deepEqual(legacy.members,[member]);
 await assert.rejects(saveDriveGroup(s,{...input(),expectedRevision:first.revision,members:[]}));
 const edited=await saveDriveGroup(s,{...input(),expectedRevision:legacy.revision,members:[{...member,role:'オーガナイザー'}]});
 assert.equal(edited.members[0].role,'オーガナイザー');
 const deleted=await saveDriveGroup(s,{...input(),expectedRevision:edited.revision,members:[]});
 assert.deepEqual(deleted.members,[]);
});

test('不正な名簿と人数上限を拒否し、既存保存を変えない',async()=>{
 const s=memory(), member={id:crypto.randomUUID(),name:'試験',role:'メンバー',note:''};
 for(const members of [null,{},[member,member],[{...member,name:' '}],[{...member,role:'a'.repeat(41)}],Array.from({length:41},()=>({...member,id:crypto.randomUUID()}))]) {
  await assert.rejects(saveDriveGroup(s,{...input(),members}));
  assert.equal(await s.get('drive:groups'),undefined);
 }
 const saved=await saveDriveGroup(s,{...input(),members:[member]});
 assert.deepEqual(normalizeGroupStore({scope:'root:true',records:[saved]}).records[0].members,[member]);
 assert.deepEqual(normalizeGroupStore({scope:'root:true',records:[{...saved,members:undefined}]}).records[0].members,[]);
});
