const itemQuery = `query($item:ID!, $cursor:String) {
  viewer { id }
  node(id:$item) { ... on ProjectV2Item {
    id updatedAt isArchived project { id title url owner { ... on User { id } } items(first:1){totalCount} }
    content { ... on DraftIssue { title } }
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
export function transport(token, send = fetch) {
  return async (query, variables, read) => {
    for (let attempt = 0; ; attempt++) {
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

export function github(config, request) {
  return {
    async read() {
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
          item.project.owner.id !== ownerId ||
          item.content?.title !== taskTitle ||
          item.project.title !== "ダッシュボード試作" ||
          item.isArchived
        )
          throw new RemoteError("試験対象が変更されています");
        if (snapshot && snapshot.revision !== item.updatedAt)
          throw new RemoteError("取得中に変更");
        snapshot ??= {
          title: taskTitle,
          status: null,
          due: null,
          revision: item.updatedAt,
          total: item.project.items.totalCount,
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
