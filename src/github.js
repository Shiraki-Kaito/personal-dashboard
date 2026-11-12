const itemQuery = `query($item:ID!, $cursor:String) {
  viewer { id }
  node(id:$item) { ... on ProjectV2Item {
    id updatedAt isArchived project { id title url owner { ... on User { id } ... on Organization { id } } items(first:1){totalCount} }
    content { ... on DraftIssue { title } ... on Issue { title url } ... on PullRequest { title url } }
    fieldValues(first:100, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { id } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id } } }
      }
    }
  }}
}`;
const update = `mutation($input:UpdateProjectV2ItemFieldValueInput!){updateProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}`;
const clear = `mutation($input:ClearProjectV2ItemFieldValueInput!){clearProjectV2ItemFieldValue(input:$input){projectV2Item{id}}}`;
export const ownerId = "U_kgDODg51tg";
export const taskTitle = "[検証用] 双方向同期テスト";
export class RemoteError extends Error {
  constructor(message, retryAt = null) {
    super(message);
    this.retryAt = retryAt;
  }
}
// 大量のページ取得で1要求を占有しないためのアプリ内上限。再試行も含める。
const maximumRequests = 40;
export function transport(token, send = fetch) {
  let requests = 0;
  return async (query, variables, read) => {
    for (let attempt = 0; ; attempt++) {
      if (requests >= maximumRequests)
        throw new RemoteError(
          "取得要求数の上限に達しました。全件取得は未完了です",
        );
      requests++;
      let reason;
      try {
        const response = await send("https://api.github.com/graphql", {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
          headers: {
            Authorization: "Bearer " + token,
            "User-Agent": "personal-dashboard",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        });
        const result = await response.json().catch(() => ({}));
        const types = (result.errors || []).map((e) => e.type);
        if (
          response.status === 429 ||
          response.headers.has("retry-after") ||
          (response.headers.get("x-ratelimit-remaining") === "0" &&
            !result.data) ||
          types.includes("RATE_LIMITED") ||
          /rate limit/i.test(result.message || "")
        ) {
          const retryDelayMs =
            Number(response.headers.get("retry-after")) * 1000;
          const resetMs =
            Number(response.headers.get("x-ratelimit-reset")) * 1000;
          const retryAt = Math.max(
            Date.now() + (retryDelayMs || 60000),
            resetMs || 0,
          );
          throw new RemoteError("レート制限", retryAt);
        }
        if (response.status === 401) throw new RemoteError("認証期限切れ");
        if (response.status === 403 || types.includes("FORBIDDEN"))
          throw new RemoteError("権限不足");
        if (types.includes("NOT_FOUND"))
          throw new RemoteError("対象消失または非表示");
        if (response.ok && result.data && !result.errors) return result.data;
        if (response.status < 500) throw new RemoteError("GitHub APIエラー");
        reason = "GitHub一時障害";
      } catch (error) {
        if (error instanceof RemoteError) throw error;
        reason = ["TimeoutError", "AbortError"].includes(error.name)
          ? "タイムアウト"
          : "通信失敗";
      }
      if (!read || attempt >= 1) throw new RemoteError(reason);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  };
}

const settingsQuery = `query($settingsProject:ID!, $cursor:String) {
 viewer { id }
 node(id:$settingsProject) { ... on ProjectV2 {
 id owner { ... on User { id } ... on Organization { id } }
 fields(first:100, after:$cursor) {
 pageInfo { hasNextPage endCursor }
 nodes {
 ... on ProjectV2Field { id name dataType }
 ... on ProjectV2SingleSelectField { id name dataType options { id name } }
 }}}}}`;

// フィールド名で別の項目へ付け替えず、設定済みIDと型を毎回照合する。
export async function projectSettings(config, request) {
  if (!config.status_field && !config.due_field)
    return { options: config.options };
  const fields = [],
    cursors = new Set();
  let cursor = null;
  do {
    const data = await request(
      settingsQuery,
      { settingsProject: config.project, cursor },
      true,
    );
    if (
      data.viewer?.id !== ownerId ||
      data.node?.id !== config.project ||
      data.node?.owner?.id !== (config.owner_id || ownerId)
    )
      throw new RemoteError("Project消失またはアクセス不可");
    const connection = data.node.fields;
    if (!Array.isArray(connection?.nodes))
      throw new RemoteError("Project設定を取得できません");
    fields.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
    if (connection.pageInfo.hasNextPage && (!cursor || cursors.has(cursor)))
      throw new RemoteError("Project設定のページ取得不整合");
    cursors.add(cursor);
  } while (cursor);
  const status = fields.find((field) => field?.id === config.status_field);
  const due = fields.find((field) => field?.id === config.due_field);
  if (
    status?.dataType !== "SINGLE_SELECT" ||
    !Array.isArray(status.options) ||
    due?.dataType !== "DATE"
  )
    throw new RemoteError(
      "状態・期限フィールドが削除または変更されています。設定の再確認が必要です",
    );
  return { options: status.options };
}

export function github(config, request) {
  return {
    async read() {
      const settings = await projectSettings(config, request);
      let cursor = null,
        snapshot;
      const cursors = new Set();
      do {
        const data = await request(
          itemQuery,
          { item: config.item, cursor },
          true,
        );
        const item = data.node;
        if (data.viewer.id !== ownerId)
          throw new RemoteError("本人以外のGitHub接続");
        if (!item?.id) throw new RemoteError("対象消失または非表示");
        if (
          item.project.id !== config.project ||
          !item.content ||
          item.project.owner.id !== (config.owner_id || ownerId) ||
          (config.mode !== "production" &&
            (item.content?.title !== taskTitle ||
              item.project.title !== "ダッシュボード試作")) ||
          item.isArchived
        )
          throw new RemoteError("試験対象が変更されています");
        if (snapshot && snapshot.revision !== item.updatedAt)
          throw new RemoteError("取得中に変更");
        snapshot ??= {
          title: item.content?.title || "内容を取得できません",
          url: item.content?.url || null,
          status: null,
          due: null,
          revision: item.updatedAt,
          total: item.project.items.totalCount,
          ...(settings.options ? { options: settings.options } : {}),
        };
        for (const field of item.fieldValues.nodes) {
          if (field?.field?.id === config.status_field)
            snapshot.status = field.optionId;
          if (field?.field?.id === config.due_field) snapshot.due = field.date;
        }
        const page = item.fieldValues.pageInfo;
        cursor = page.hasNextPage ? page.endCursor : null;
        if (page.hasNextPage && (!cursor || cursors.has(cursor)))
          throw new RemoteError("ページ取得不整合");
        cursors.add(cursor);
      } while (cursor);
      return snapshot;
    },
    async write(field, value) {
      const settings = await projectSettings(config, request);
      if (
        field === "status" &&
        value !== null &&
        !settings.options?.some((option) => option.id === value)
      )
        throw new RemoteError(
          "選択した状態が削除されています。未同期操作を破棄し、一覧を更新してください",
        );
      const input = {
        projectId: config.project,
        itemId: config.item,
        fieldId: field === "due" ? config.due_field : config.status_field,
      };
      if (value !== null)
        input.value =
          field === "due" ? { date: value } : { singleSelectOptionId: value };
      await request(value === null ? clear : update, { input }, false);
    },
  };
}
