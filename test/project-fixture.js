import { ownerId } from "../src/github.js";
export function settingsFixture(config) {
  return {
    viewer: { id: ownerId },
    node: {
      id: config.project,
      owner: { id: ownerId },
      fields: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            id: config.status_field,
            dataType: "SINGLE_SELECT",
            options: config.options || [],
          },
          { id: config.due_field, dataType: "DATE" },
        ],
      },
    },
  };
}
