import { linkByDiscordId } from "../config/user-links.js";
import { notion } from "./notion-client.js";
import { buildEvidenceBlocks } from "./notion-files.js";
import { judgeDuplicates } from "./openai.js";
import { findDuplicates } from "../lib/duplicates.js";
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
  AREA: "Área",
  COMPLETED: "Completed",
  RELEASE_VIDEO: "Video release",
  RELEASE_PUBLISHED: "Release publicado",
  RELEASE_MESSAGE: "Release Discord",
  RELEASE_SUMMARY: "Release resumen",
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

/**
 * Resolves the Notion user for a Discord reporter. The identity table wins; name
 * matching is the fallback for whoever isn't in it yet.
 */
export function resolveReporterId(discordUserId, discordNames, userOptions) {
  const linked = linkByDiscordId(discordUserId)?.notionId;
  if (linked && userOptions.some((u) => u.id === linked)) return linked;
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
 * Workspace members (type === "person"), following pagination — bots and guests
 * can't be picked as reporter or assignee.
 */
export async function listWorkspaceUsers() {
  const users = [];
  let cursor;

  do {
    const res = await notion.users.list({ start_cursor: cursor, page_size: 100 });
    users.push(
      ...res.results
        .filter((u) => u.type === "person")
        .map((u) => ({ id: u.id, name: u.name }))
    );
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return users;
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
  const [db, workspaceUsers] = await Promise.all([
    notion.databases.retrieve({ database_id: DATABASE_ID }),
    listWorkspaceUsers(),
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

  let userOptions = workspaceUsers;

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
    precheckBlocks = [],
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

  // Files are re-uploaded to Notion: Discord's CDN links expire within a day.
  const evidenceBlocks =
    attachments.length > 0
      ? [
          {
            object: "block",
            type: "heading_2",
            heading_2: {
              rich_text: [{ text: { content: "Evidence" } }],
            },
          },
          ...(await buildEvidenceBlocks(attachments)),
        ]
      : [];

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
      ...evidenceBlocks,
      // Only when the reporter went ahead despite the AI pre-check's warning
      ...precheckBlocks,
    ],
  });

  return { id: response.id, url: response.url };
}

// ─── Duplicates ───────────────────────────────────────────────────────────────

/** Bug tickets that aren't finished yet — the only ones a new report can join. */
export async function fetchOpenBugTickets() {
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });

  const pages = await queryAll({
    and: [
      { property: PROP.TASK_TYPE, select: { equals: BUG_TASK_TYPE } },
      ...completeStatusNames(db).map((name) => ({
        property: PROP.STATUS,
        status: { does_not_equal: name },
      })),
    ],
  });

  return pages.map((page) => {
    const title = getPageTitle(page) ?? "(sin título)";
    return {
      id: page.id,
      url: page.url,
      title,
      status: page.properties?.[PROP.STATUS]?.status?.name ?? null,
      text: title,
    };
  });
}

/**
 * Open bug tickets the AI considers the same bug as this analysis, each with a
 * `reason`. Tickets are shortlisted by title, then the AI reads the first lines of
 * each shortlisted page — the description lives in the body, not in a property.
 */
export async function findSimilarTickets(analysis, { judge = judgeDuplicates } = {}) {
  const tickets = await fetchOpenBugTickets();
  const { matches } = await findDuplicates({
    candidate: {
      title: analysis.title,
      summary: `${analysis.description}\n${analysis.stepsToReproduce ?? ""}`,
    },
    items: tickets,
    enrich: (shortlist) =>
      Promise.all(
        shortlist.map(async (t) => ({
          ...t,
          text: `${t.title}\n${await fetchPageText(t.id, { maxLines: 15 })}`,
        }))
      ),
    judge: judge && ((args) => judge({ kind: "bug", ...args })),
  });
  return matches;
}

/** The comment a new report leaves on the ticket it turned out to duplicate. */
export function buildTicketCaseComment({ analysis, reporterName, threadUrl, evidenceSummary }) {
  const text =
    `➕ New case of this bug from Discord — reported by ${reporterName}\n\n` +
    `${analysis.description}\n\n` +
    `Steps to reproduce:\n${analysis.stepsToReproduce || "Not specified"}\n` +
    (evidenceSummary ? `\nEvidence in the thread: ${evidenceSummary}\n` : "") +
    `\nDiscord thread: `;

  const content = text.length > 1800 ? `${text.slice(0, 1799)}…` : text;
  return [
    { type: "text", text: { content } },
    { type: "text", text: { content: threadUrl, link: { url: threadUrl } } },
  ];
}

/** Adds a new report to an existing ticket as a page comment. */
export async function addTicketComment(pageId, details) {
  await notion.comments.create({
    parent: { page_id: pageId },
    rich_text: buildTicketCaseComment(details),
  });
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
 * Covers every task type, not just bugs: whoever asked for a polish or a feature
 * wants to hear it shipped just as much. Tickets opened by hand in Notion are
 * included too — they just have no thread to reply into, so the watcher falls back
 * to the channel.
 *
 * @returns {Promise<Array<{pageId, title, url, status, taskType, threadId, threadUrl, reporterName, reporterDiscordId, reporterNotionId, reporterNotionName}>>}
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
    ],
  });

  return pages
    .map((page) => {
      const description = getRichText(page, PROP.DESCRIPTION);
      const threadUrl = description.match(/Discord thread:\s*(\S+)/)?.[1] ?? null;
      // .../channels/{guildId}/{threadId}
      const threadId = threadUrl?.match(/\/(\d+)\s*$/)?.[1] ?? null;

      const reporter = page.properties?.[PROP.REPORTER]?.people?.[0] ?? null;

      return {
        pageId: page.id,
        title: getPageTitle(page) ?? "(sin título)",
        url: page.url,
        status: page.properties?.[PROP.STATUS]?.status?.name ?? null,
        taskType: page.properties?.[PROP.TASK_TYPE]?.select?.name ?? null,
        threadId,
        threadUrl,
        reporterName:
          description.match(/Reported by:\s*([^\n(]+)/)?.[1]?.trim() ?? null,
        reporterDiscordId:
          description.match(/Discord ID:\s*(\d+)/)?.[1] ?? null,
        reporterNotionId: reporter?.id ?? null,
        reporterNotionName: reporter?.name ?? null,
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

// ─── Releases ─────────────────────────────────────────────────────────────────

/** Task types that never reach #releases — internal work nobody outside asked for. */
const RELEASE_EXCLUDED_TASK_TYPES = ["🔧 Chore"];

/**
 * Normalizes the first entry of the "Video release" property. Despite the column
 * name it takes a screenshot just as happily as a clip.
 *
 * Notion serves uploaded files behind a signed URL that expires in about an hour,
 * so a `hosted` file has to be downloaded and re-uploaded to Discord — linking to
 * it would post a URL that dies the same afternoon. An `external` entry (Loom,
 * YouTube, Drive, an image URL) is permanent and can be used as-is.
 */
function readReleaseMedia(page) {
  const entry = (page.properties?.[PROP.RELEASE_VIDEO]?.files ?? [])[0];
  if (!entry) return null;

  const name = entry.name ?? null;
  return entry.type === "external"
    ? { kind: "external", url: entry.external.url, name }
    : { kind: "hosted", url: entry.file.url, name };
}

/**
 * The release copy stored on the page when it was announced: first line the
 * headline, the rest the summary. Kept as one readable column instead of two, and
 * it is what the Friday digest reuses so the wording matches the release message.
 */
function readStoredNote(page) {
  const stored = getRichText(page, PROP.RELEASE_SUMMARY).trim();
  if (!stored) return null;

  const [headline, ...rest] = stored.split("\n");
  return {
    headline: headline.trim(),
    summary: rest.join("\n").trim(),
    details: [],
  };
}

/** Shapes a Notion page into the ticket the release messages are built from. */
function mapReleaseTicket(page) {
  const description = getRichText(page, PROP.DESCRIPTION);

  return {
    pageId: page.id,
    title: getPageTitle(page) ?? "(sin título)",
    url: page.url,
    // Used as a "has anyone stopped touching this?" signal before announcing it.
    lastEditedTime: page.last_edited_time ?? null,
    status: page.properties?.[PROP.STATUS]?.status?.name ?? null,
    taskType: page.properties?.[PROP.TASK_TYPE]?.select?.name ?? null,
    areas: (page.properties?.[PROP.AREA]?.multi_select ?? []).map((o) => o.name),
    completedAt: page.properties?.[PROP.COMPLETED]?.date?.start ?? null,
    threadUrl: description.match(/Discord thread:\s*(\S+)/)?.[1] ?? null,
    reporterName: description.match(/Reported by:\s*([^\n(]+)/)?.[1]?.trim() ?? null,
    reporterNotionId: page.properties?.[PROP.REPORTER]?.people?.[0]?.id ?? null,
    reporterNotionName: page.properties?.[PROP.REPORTER]?.people?.[0]?.name ?? null,
    // Whoever did the work. Carries the Notion id so it can be turned into a
    // Discord tag through the identity table.
    assignees: (page.properties?.[PROP.ASSIGNEE]?.people ?? []).map((u) => ({
      notionId: u.id,
      name: u.name ?? null,
    })),
    descriptionText: description,
    media: readReleaseMedia(page),
    releaseMessageUrl: page.properties?.[PROP.RELEASE_MESSAGE]?.url ?? null,
    storedNote: readStoredNote(page),
  };
}

/** Filter clauses for "status is in the Complete group". */
function completedFilter(db) {
  return {
    or: completeStatusNames(db).map((name) => ({
      property: PROP.STATUS,
      status: { equals: name },
    })),
  };
}

/**
 * Filter clauses excluding the task types that don't belong in #releases.
 * `does_not_equal` also keeps pages with no task type at all, which is what we
 * want — an untyped ticket is still something that shipped.
 */
function excludedTaskTypeFilters() {
  return RELEASE_EXCLUDED_TASK_TYPES.map((taskType) => ({
    property: PROP.TASK_TYPE,
    select: { does_not_equal: taskType },
  }));
}

/**
 * Makes sure the release columns exist in the database.
 *
 * As with "Discord notificado", the first time the published flag is created every
 * already-completed ticket is back-filled as published — otherwise switching the
 * feature on would dump months of history into #releases at once.
 *
 * @returns {Promise<{created: string[], backfilled: number}>}
 */
export async function ensureReleaseProperties() {
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });

  const missing = {};
  if (!db.properties[PROP.RELEASE_VIDEO]) missing[PROP.RELEASE_VIDEO] = { files: {} };
  if (!db.properties[PROP.RELEASE_MESSAGE]) missing[PROP.RELEASE_MESSAGE] = { url: {} };
  if (!db.properties[PROP.RELEASE_SUMMARY]) {
    missing[PROP.RELEASE_SUMMARY] = { rich_text: {} };
  }

  const isFirstRun = !db.properties[PROP.RELEASE_PUBLISHED];
  if (isFirstRun) missing[PROP.RELEASE_PUBLISHED] = { checkbox: {} };

  const created = Object.keys(missing);
  if (created.length > 0) {
    await notion.databases.update({
      database_id: DATABASE_ID,
      properties: missing,
    });
    console.log(`[Notion] Propiedades creadas: ${created.join(", ")}`);
  }

  if (!isFirstRun) return { created, backfilled: 0 };

  const pages = await queryAll(completedFilter(db));
  for (const page of pages) {
    await markReleasePublished(page.id);
  }

  console.log(
    `[Notion] ${pages.length} ticket(s) ya completados marcados como publicados (back-fill inicial).`
  );
  return { created, backfilled: pages.length };
}

/** Completed tickets that still have to be announced in #releases. */
export async function fetchUnpublishedReleases() {
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });

  const pages = await queryAll({
    and: [
      completedFilter(db),
      { property: PROP.RELEASE_PUBLISHED, checkbox: { equals: false } },
      ...excludedTaskTypeFilters(),
    ],
  });

  return pages.map(mapReleaseTicket);
}

/**
 * Tickets completed within a date range, for the weekly digest.
 * `Completed` is a date-only property, so both bounds are YYYY-MM-DD and inclusive.
 */
export async function fetchReleasesCompletedBetween(startDate, endDate) {
  const db = await notion.databases.retrieve({ database_id: DATABASE_ID });

  const pages = await queryAll({
    and: [
      completedFilter(db),
      { property: PROP.COMPLETED, date: { on_or_after: startDate } },
      { property: PROP.COMPLETED, date: { on_or_before: endDate } },
      ...excludedTaskTypeFilters(),
    ],
  });

  return pages
    .map(mapReleaseTicket)
    .sort(
      (a, b) =>
        (a.completedAt ?? "").localeCompare(b.completedAt ?? "") ||
        a.title.localeCompare(b.title)
    );
}

/**
 * The page body as plain text, used as extra context for the release summary.
 * Only top-level blocks are read — the detail lives in the first screen of the
 * ticket, and recursing into children would cost a request per nested block.
 */
export async function fetchPageText(pageId, { maxLines = 60 } = {}) {
  const lines = [];
  let cursor;

  do {
    const res = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });

    for (const block of res.results) {
      const richText = block[block.type]?.rich_text;
      if (!Array.isArray(richText)) continue;

      const text = richText.map((t) => t.plain_text).join("").trim();
      if (!text) continue;

      lines.push(block.type.startsWith("heading") ? `## ${text}` : text);
      if (lines.length >= maxLines) return lines.join("\n");
    }

    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return lines.join("\n");
}

/**
 * Marks a ticket as announced, keeping the link to its message in #releases and
 * the copy that was published, which the weekly digest reads back.
 */
export async function markReleasePublished(pageId, { messageUrl, note } = {}) {
  const properties = { [PROP.RELEASE_PUBLISHED]: { checkbox: true } };

  if (messageUrl) properties[PROP.RELEASE_MESSAGE] = { url: messageUrl };

  if (note?.summary) {
    // Notion caps a rich_text chunk at 2000 characters.
    const content = `${note.headline}\n${note.summary}`.slice(0, 1900);
    properties[PROP.RELEASE_SUMMARY] = { rich_text: [{ text: { content } }] };
  }

  await notion.pages.update({ page_id: pageId, properties });
}
