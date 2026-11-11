import { ownerId, RemoteError, github } from "./github.js";
import { InputError } from "./sync.js";

const fieldPageSize = 20;
const query = `query($project:ID!, $cursor:String) {
  viewer { id }
  node(id:$project) { ... on ProjectV2 {
    id title url owner { ... on User { id } ... on Organization { id } }
    items(first:100, after:$cursor) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { id updatedAt isArchived
      fieldValues(first:${fieldPageSize}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { id } } }
          ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id } } }
        }
      }
      content {
        ... on DraftIssue { title }
        ... on Issue { title url }
        ... on PullRequest { title url }
      }}
    }
  }}
}`;

export function projectsFrom(raw) {
  const config = JSON.parse(raw);
  return config.projects || [config];
}

export function taskStorage(storage, config, legacyItem) {
  const key = "task:" + config.project + ":" + config.item;
  return {
    async get() {
      const current = await storage.get(key);
      if (current) return current;
      if (config.item === legacyItem) return storage.get("sync");
    },
    put: (_, value) => storage.put(key, value),
  };
}

export async function catalog(config, request, storage, refresh) {
  const key = "catalog:" + config.project;
  const saved = (await storage.get(key)) || {
    items: [],
    total: null,
    lastSuccess: null,
    lastAttempt: null,
    error: null,
  };
  if (!refresh || saved.retryAt > Date.now()) return saved;
  saved.lastAttempt = new Date().toISOString();
  await storage.put(key, saved);
  try {
    let cursor = null,
      total,
      title,
      url;
    const cursors = new Set(),
      ids = new Set(),
      items = [];
    do {
      const data = await request(
        query,
        { project: config.project, cursor },
        true,
      );
      const project = data.node;
      if (data.viewer.id !== ownerId)
        throw new RemoteError("本人以外のGitHub接続");
      if (!project?.id || project.owner.id !== (config.owner_id || ownerId))
        throw new RemoteError("Project消失またはアクセス不可");
      const connection = project.items;
      total ??= connection.totalCount;
      if (total !== connection.totalCount)
        throw new RemoteError("取得中に件数が変更されました");
      title = project.title;
      url = project.url;
      for (const item of connection.nodes) {
        if (!item || ids.has(item.id)) throw new RemoteError("一覧取得不整合");
        ids.add(item.id);
        const editable = !item.isArchived && !!item.content;
        let values = {};
        if (editable && config.status_field && config.due_field) {
          if (!Array.isArray(item.fieldValues?.nodes))
            throw new RemoteError("状態・期限の取得が未完了です");
          if (item.fieldValues.pageInfo.hasNextPage) {
            // 項目数が多いタスクだけ、既存アダプターで全ページとリビジョンを照合する。
            const detail = await github(
              { ...config, item: item.id },
              request,
            ).read();
            if (detail.revision !== item.updatedAt)
              throw new RemoteError("取得中にタスクが変更されました");
            values = {
              status: detail.status,
              due: detail.due,
              fieldsComplete: true,
            };
          } else {
            values = { status: null, due: null, fieldsComplete: true };
            for (const field of item.fieldValues.nodes) {
              if (field?.field?.id === config.status_field)
                values.status = field.optionId;
              if (field?.field?.id === config.due_field)
                values.due = field.date;
            }
          }
        }
        items.push({
          id: item.id,
          title: item.content?.title || "内容を取得できません",
          url: item.content?.url || null,
          archived: item.isArchived,
          accessible: !!item.content,
          editable,
          ...values,
        });
      }
      const page = connection.pageInfo;
      cursor = page.hasNextPage ? page.endCursor : null;
      if (page.hasNextPage && (!cursor || cursors.has(cursor)))
        throw new RemoteError("ページ取得不整合");
      cursors.add(cursor);
    } while (cursor);
    if (items.length !== total)
      throw new RemoteError("GitHub件数と取得件数が不一致");
    Object.assign(saved, {
      items,
      total,
      title,
      url,
      error: null,
      retryAt: null,
      lastSuccess: new Date().toISOString(),
      hasPriorityFields: !!config.status_field && !!config.due_field,
    });
  } catch (error) {
    if (!(error instanceof RemoteError)) throw error;
    saved.error = error.message;
    saved.retryAt = error.retryAt;
  }
  await storage.put(key, saved);
  return saved;
}

export async function selectTask(projects, projectId, itemId, storage) {
  const project = projects.find((p) => p.project === projectId);
  if (!project || typeof itemId !== "string")
    throw new InputError("対象Project・タスクが不正です");
  if (project.mode !== "production" && itemId !== project.item)
    throw new InputError("試験対象外です");
  const saved = await storage.get("catalog:" + projectId);
  if (
    itemId !== project.item &&
    !saved?.items.some((i) => i.id === itemId && i.editable)
  )
    throw new InputError("一覧を更新して対象タスクを選択してください");
  return { ...project, item: itemId };
}
