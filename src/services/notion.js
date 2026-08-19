import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

/**
 * Property names in the "Tasks Tracker Especialistas" database.
 * If the DB schema is renamed in Notion, update these in one place.
 * NOTE: `TITLE` uses the literal id "title" (the id of the "Task name" property),
 * which stays stable even if the column is renamed.
 */
const PROP = {
  TITLE: "title",
  PRIORITY: "Priority",
  STATUS: "Status",
  TASK_TYPE: "Task type",
  DESCRIPTION: "Descripción",
  SPRINT: "Sprint",
  ASSIGNEE: "Assignee",
};

const DEFAULT_STATUS = "Not started";
const BUG_TASK_TYPE = "🐞 Bug";

/** Notion user pre-selected as assignee on every new ticket (optional). */
const DEFAULT_ASSIGNEE_ID = process.env.NOTION_DEFAULT_ASSIGNEE_ID || null;

/**
 * Notion's native sprints expose a "Sprint status" of Current / Next / Future / Last / Past.
 * Only these three are offered — a fresh bug should never land in a closed sprint.
 * The order here is also the order shown in the Discord dropdown.
 */
const SPRINT_STATUS_ORDER = { Current: 0, Next: 1, Future: 2 };

/** Reads the title of a Notion page regardless of how its title column is named. */
function getPageTitle(page) {
  const titleProp = Object.values(page.properties ?? {}).find(
    (p) => p.type === "title"
  );
  return titleProp?.title?.[0]?.plain_text ?? null;
}

/**
 * Fetches dynamic options from Notion for the ticket form:
 * - Priority select options
 * - Sprint options (relation / select / multi_select are all supported)
 * - Assignee workspace users
 *
 * Also returns `sprintType` so createTicket doesn't have to re-fetch the schema.
 */
export async function fetchTicketOptions() {
  const [db, usersRes] = await Promise.all([
    notion.databases.retrieve({ database_id: DATABASE_ID }),
    notion.users.list({}),
  ]);

  // Priority — from select property schema
  const priorityOptions = db.properties[PROP.PRIORITY]?.select?.options?.map(
    (o) => o.name
  ) ?? ["Urgent", "High", "Medium", "Low"];

  // Sprint — detect property type and fetch accordingly
  const sprintProp = db.properties[PROP.SPRINT];
  const sprintType = sprintProp?.type ?? null;

  let sprintOptions = [];

  if (sprintType === "relation") {
    // Sprint is a relation to the Sprints database
    const sprintRelationDbId = sprintProp.relation?.database_id;
    if (sprintRelationDbId) {
      const res = await notion.databases.query({
        database_id: sprintRelationDbId,
        page_size: 50,
        sorts: [{ timestamp: "created_time", direction: "descending" }],
      });
      sprintOptions = res.results
        .map((p) => ({
          id: p.id,
          name: getPageTitle(p),
          // Absent on non-native sprint databases — those sprints are all kept.
          status: p.properties?.["Sprint status"]?.status?.name ?? null,
        }))
        .filter((s) => s.name && (s.status === null || s.status in SPRINT_STATUS_ORDER))
        .sort(
          (a, b) =>
            (SPRINT_STATUS_ORDER[a.status] ?? 99) -
            (SPRINT_STATUS_ORDER[b.status] ?? 99)
        );
    }
  } else if (sprintType === "select") {
    const allOptions = (sprintProp.select?.options ?? []).map((o) => ({
      id: o.name,
      name: o.name,
    }));
    // Show only: Backlog + the latest sprint (last one created)
    const backlog = allOptions.find((o) =>
      o.name.toLowerCase().includes("backlog")
    );
    const latestSprint = [...allOptions]
      .reverse()
      .find((o) => !o.name.toLowerCase().includes("backlog"));
    sprintOptions = [backlog, latestSprint].filter(Boolean);
  } else if (sprintType === "multi_select") {
    sprintOptions = (sprintProp.multi_select?.options ?? []).map((o) => ({
      id: o.name,
      name: o.name,
    }));
  }

  // Assignee — workspace members only (type === "person")
  let userOptions = usersRes.results
    .filter((u) => u.type === "person")
    .map((u) => ({ id: u.id, name: u.name }));

  // Only honour the configured default if that user still exists in the workspace,
  // and float it to the top so it survives Discord's 25-option cap.
  const defaultAssigneeId = userOptions.some((u) => u.id === DEFAULT_ASSIGNEE_ID)
    ? DEFAULT_ASSIGNEE_ID
    : null;

  // Fail loudly: a missing/stale default silently produces unassigned tickets,
  // which looks like a bug in the menu rather than a config problem.
  if (!DEFAULT_ASSIGNEE_ID) {
    console.warn(
      "[Notion] NOTION_DEFAULT_ASSIGNEE_ID no está definido — los tickets saldrán sin asignar. " +
        "¿Reiniciaste el bot después de editar el .env?"
    );
  } else if (!defaultAssigneeId) {
    console.warn(
      `[Notion] NOTION_DEFAULT_ASSIGNEE_ID="${DEFAULT_ASSIGNEE_ID}" no coincide con ningún ` +
        "usuario del workspace — los tickets saldrán sin asignar."
    );
  }
  if (defaultAssigneeId) {
    userOptions = [
      ...userOptions.filter((u) => u.id === defaultAssigneeId),
      ...userOptions.filter((u) => u.id !== defaultAssigneeId),
    ];
  }

  return {
    priorityOptions,
    sprintOptions,
    sprintType,
    userOptions,
    defaultAssigneeId,
  };
}

/**
 * Creates a bug ticket in the Notion database.
 */
export async function createTicket(ticket) {
  const {
    title,
    description,
    priority,
    stepsToReproduce,
    reporterName,
    threadUrl,
    sprintId,
    sprintType,
    assigneeId,
    attachments = [],
  } = ticket;

  const properties = {
    [PROP.TITLE]: {
      title: [{ text: { content: title } }],
    },
    [PROP.PRIORITY]: {
      select: { name: priority },
    },
    [PROP.STATUS]: {
      status: { name: DEFAULT_STATUS },
    },
    [PROP.TASK_TYPE]: {
      select: { name: BUG_TASK_TYPE },
    },
    [PROP.DESCRIPTION]: {
      rich_text: [
        {
          text: {
            content: `Discord thread: ${threadUrl}\nReported by: ${reporterName}`,
          },
        },
      ],
    },
  };

  if (sprintId) {
    if (sprintType === "relation") {
      properties[PROP.SPRINT] = { relation: [{ id: sprintId }] };
    } else if (sprintType === "select") {
      // sprintId holds the option name in this case
      properties[PROP.SPRINT] = { select: { name: sprintId } };
    } else if (sprintType === "multi_select") {
      properties[PROP.SPRINT] = { multi_select: [{ name: sprintId }] };
    }
  }

  if (assigneeId) {
    properties[PROP.ASSIGNEE] = { people: [{ object: "user", id: assigneeId }] };
  }

  const response = await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties,
    children: [
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Task description" } }],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: description } }],
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Steps to reproduce" } }],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: stepsToReproduce } }],
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ text: { content: "Source" } }],
        },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              text: {
                content: `Reported by: ${reporterName}\nDiscord thread: `,
              },
            },
            {
              text: { content: threadUrl, link: { url: threadUrl } },
            },
          ],
        },
      },
      // Evidence section — only added if there are attachments
      ...(attachments.length > 0
        ? [
            {
              object: "block",
              type: "heading_2",
              heading_2: {
                rich_text: [{ text: { content: "Evidence" } }],
              },
            },
            ...attachments.map((a) => {
              const type = a.contentType || "";
              if (type.startsWith("image/")) {
                return {
                  object: "block",
                  type: "image",
                  image: { type: "external", external: { url: a.url } },
                };
              } else if (type.startsWith("video/")) {
                return {
                  object: "block",
                  type: "video",
                  video: { type: "external", external: { url: a.url } },
                };
              } else {
                // Generic file — add as a link paragraph
                return {
                  object: "block",
                  type: "paragraph",
                  paragraph: {
                    rich_text: [
                      {
                        text: {
                          content: `📎 ${a.name}`,
                          link: { url: a.url },
                        },
                      },
                    ],
                  },
                };
              }
            }),
          ]
        : []),
    ],
  });

  return { id: response.id, url: response.url };
}
