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
  REPORTER: "Reporter",
  NOTIFIED: "Discord notificado",
};

const DEFAULT_STATUS = "Not started";
const BUG_TASK_TYPE = "🐞 Bug";

/**
 * Notion groups its status options into To-do / In progress / Complete.
 * A ticket counts as "listo" when its status lands in the Complete group, so a
 * renamed or newly added completed-state keeps working without a code change.
 */
const COMPLETE_GROUP = "Complete";
const DONE_STATUS_FALLBACK = ["Done"];

/** Notion user pre-selected as assignee on every new ticket (optional). */
const DEFAULT_ASSIGNEE_ID = process.env.NOTION_DEFAULT_ASSIGNEE_ID || null;

/**
 * Explicit Discord-user-id -> Notion-user-id overrides, as JSON in the env:
 *   DISCORD_NOTION_REPORTER_MAP={"123456789":"a1b2c3d4-...."}
 * Name matching (below) covers the common case; this pins the ones it gets wrong.
 */
const REPORTER_MAP = (() => {
  const raw = process.env.DISCORD_NOTION_REPORTER_MAP;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(
      "[Notion] DISCORD_NOTION_REPORTER_MAP no es JSON válido — se ignora."
    );
    return {};
  }
})();

/** Lowercases and strips accents so "Nicolás" and "nicolas" compare equal. */
function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Best-effort guess of which Notion workspace user is this Discord user.
 * Exact normalized match first, then a shared first name — Discord handles and
 * Notion display names rarely agree, so the reporter can still fix it in the menu.
 */
export function matchNotionUser(discordNames, userOptions) {
  const candidates = discordNames.filter(Boolean).map(normalizeName);
  if (candidates.length === 0) return null;

  const exact = userOptions.find((u) =>
    candidates.includes(normalizeName(u.name))
  );
  if (exact) return exact.id;

  const partial = userOptions.find((u) => {
    const notionFirst = normalizeName(u.name).split(/\s+/)[0];
    if (!notionFirst) return false;
    return candidates.some((c) => {
      const discordFirst = c.split(/[\s._-]+/)[0];
      return discordFirst === notionFirst;
    });
  });
  return partial?.id ?? null;
}

/** Resolves the Notion user for a Discord reporter: env override wins over name matching. */
export function resolveReporterId(discordUserId, discordNames, userOptions) {
  const pinned = REPORTER_MAP[discordUserId];
  if (pinned && userOptions.some((u) => u.id === pinned)) return pinned;
  return matchNotionUser(discordNames, userOptions);
}

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
    reporterDiscordId,
    threadUrl,
    sprintId,
    sprintType,
    assigneeId,
    reporterId,
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
            content:
              `Discord thread: ${threadUrl}\n` +
              `Reported by: ${reporterName}` +
              (reporterDiscordId ? ` (Discord ID: ${reporterDiscordId})` : ""),
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

  if (reporterId) {
    properties[PROP.REPORTER] = { people: [{ object: "user", id: reporterId }] };
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
                content:
                  `Reported by: ${reporterName}` +
                  (reporterDiscordId ? ` (Discord ID: ${reporterDiscordId})` : "") +
                  `\nDiscord thread: `,
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

// ─── Completion notifications ─────────────────────────────────────────────────

/** Reads the plain text of a rich_text property. */
function getRichText(page, propName) {
  return (page.properties?.[propName]?.rich_text ?? [])
    .map((t) => t.plain_text)
    .join("");
}

/** Status option names that mean "listo", read from Notion's Complete group. */
function completeStatusNames(db) {
  const statusProp = db.properties[PROP.STATUS]?.status;
  if (!statusProp) return DONE_STATUS_FALLBACK;

  const group = (statusProp.groups ?? []).find(
    (g) => g.name === COMPLETE_GROUP
  );
  if (!group) return DONE_STATUS_FALLBACK;

  const byId = new Map(statusProp.options.map((o) => [o.id, o.name]));
  const names = group.option_ids.map((id) => byId.get(id)).filter(Boolean);
  return names.length > 0 ? names : DONE_STATUS_FALLBACK;
}

/**
 * Makes sure the "Discord notificado" checkbox exists in the database.
 *
 * The first time it is created, every already-completed ticket is back-filled as
 * notified — otherwise switching this feature on would blast a notification into
 * every old thread at once.
 *
 * @returns {Promise<{created: boolean, backfilled: number}>}
 */
export async function ensureNotifiedProperty() {
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });
  if (db.properties[PROP.NOTIFIED]) return { created: false, backfilled: 0 };

  await notion.databases.update({
    database_id: DATABASE_ID,
    properties: { [PROP.NOTIFIED]: { checkbox: {} } },
  });
  console.log(`[Notion] Propiedad "${PROP.NOTIFIED}" creada en la base.`);

  // Back-fill: mark everything already completed as notified.
  const doneNames = completeStatusNames(db);
  const pages = await queryAll({
    and: [
      {
        or: doneNames.map((name) => ({
          property: PROP.STATUS,
          status: { equals: name },
        })),
      },
      { property: PROP.TASK_TYPE, select: { equals: BUG_TASK_TYPE } },
    ],
  });

  for (const page of pages) {
    await markTicketNotified(page.id);
  }

  console.log(
    `[Notion] ${pages.length} ticket(s) ya completados marcados como notificados (back-fill inicial).`
  );
  return { created: true, backfilled: pages.length };
}

/** Runs a database query, following pagination. */
async function queryAll(filter) {
  const results = [];
  let cursor;

  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter,
      page_size: 100,
      start_cursor: cursor,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return results;
}

/**
 * Finds tickets that reached a completed status and have not been announced in
 * Discord yet.
 *
 * Scoped to bugs: the announcement lands in #bug-reports, so completed chores and
 * feature requests have no business there. Tickets opened by hand in Notion are
 * included too — they just have no thread to reply into, so the watcher falls back
 * to the channel.
 *
 * @returns {Promise<Array<{pageId, title, url, status, threadId, threadUrl, reporterName, reporterDiscordId}>>}
 */
export async function fetchCompletedUnnotifiedTickets() {
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });
  const doneNames = completeStatusNames(db);

  const pages = await queryAll({
    and: [
      {
        or: doneNames.map((name) => ({
          property: PROP.STATUS,
          status: { equals: name },
        })),
      },
      { property: PROP.NOTIFIED, checkbox: { equals: false } },
      { property: PROP.TASK_TYPE, select: { equals: BUG_TASK_TYPE } },
    ],
  });

  return pages
    .map((page) => {
      const description = getRichText(page, PROP.DESCRIPTION);
      const threadUrl = description.match(/Discord thread:\s*(\S+)/)?.[1] ?? null;
      // .../channels/{guildId}/{threadId}
      const threadId = threadUrl?.match(/\/(\d+)\s*$/)?.[1] ?? null;

      return {
        pageId: page.id,
        title: getPageTitle(page) ?? "(sin título)",
        url: page.url,
        status: page.properties?.[PROP.STATUS]?.status?.name ?? null,
        threadId,
        threadUrl,
        reporterName:
          description.match(/Reported by:\s*([^\n(]+)/)?.[1]?.trim() ?? null,
        reporterDiscordId:
          description.match(/Discord ID:\s*(\d+)/)?.[1] ?? null,
      };
    });
}

/** Ticks the "Discord notificado" checkbox so the ticket is never announced twice. */
export async function markTicketNotified(pageId) {
  await notion.pages.update({
    page_id: pageId,
    properties: { [PROP.NOTIFIED]: { checkbox: true } },
  });
}
