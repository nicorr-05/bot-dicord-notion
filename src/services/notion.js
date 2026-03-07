import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

/**
 * Fetches dynamic options from Notion for the ticket form:
 * - Priority select options
 * - Sprint relation options (latest 10)
 * - Assignee workspace users
 */
export async function fetchTicketOptions() {
  const [db, usersRes] = await Promise.all([
    notion.databases.retrieve({ database_id: DATABASE_ID }),
    notion.users.list({}),
  ]);

  // Priority — from select property schema
  const priorityOptions =
    db.properties.Priority?.select?.options?.map((o) => o.name) ?? [
      "Urgent",
      "High",
      "Low",
    ];

  // Sprint — detect property type and fetch accordingly
  const sprintProp = db.properties.Sprint;
  console.log("[Notion] Sprint property type:", sprintProp?.type, JSON.stringify(sprintProp).slice(0, 200));

  let sprintOptions = [];

  if (sprintProp?.type === "relation") {
    // Sprint is a relation to another database
    const sprintRelationDbId = sprintProp.relation?.database_id;
    if (sprintRelationDbId) {
      const res = await notion.databases.query({
        database_id: sprintRelationDbId,
        page_size: 10,
        sorts: [{ timestamp: "created_time", direction: "descending" }],
      });
      sprintOptions = res.results
        .map((p) => ({
          id: p.id,
          name:
            p.properties.Name?.title?.[0]?.plain_text ??
            p.properties.title?.title?.[0]?.plain_text ??
            "Unnamed Sprint",
        }))
        .filter((s) => s.name !== "Unnamed Sprint");
    }
  } else if (sprintProp?.type === "select") {
    const allOptions = (sprintProp.select?.options ?? []).map((o) => ({
      id: o.name,
      name: o.name,
    }));
    // Show only: Backlog + the latest sprint (last one created)
    const backlog = allOptions.find((o) => o.name.toLowerCase().includes("backlog"));
    const latestSprint = [...allOptions].reverse().find((o) => !o.name.toLowerCase().includes("backlog"));
    sprintOptions = [backlog, latestSprint].filter(Boolean);
  } else if (sprintProp?.type === "multi_select") {
    sprintOptions = (sprintProp.multi_select?.options ?? []).map((o) => ({
      id: o.name,
      name: o.name,
    }));
  }

  // Assignee — workspace members only (type === "person")
  const userOptions = usersRes.results
    .filter((u) => u.type === "person")
    .map((u) => ({ id: u.id, name: u.name }));

  return { priorityOptions, sprintOptions, userOptions };
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
    assigneeId,
    attachments = [],
  } = ticket;

  const properties = {
    title: {
      title: [{ text: { content: title } }],
    },
    Priority: {
      select: { name: priority },
    },
    Status: {
      status: { name: "Not started" },
    },
    Text: {
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
    // Check Sprint property type to set the correct value format
    const db = await notion.databases.retrieve({ database_id: DATABASE_ID });
    const sprintType = db.properties.Sprint?.type;
    if (sprintType === "relation") {
      properties.Sprint = { relation: [{ id: sprintId }] };
    } else if (sprintType === "select") {
      properties.Sprint = { select: { name: sprintId } }; // sprintId holds the name in this case
    } else if (sprintType === "multi_select") {
      properties.Sprint = { multi_select: [{ name: sprintId }] };
    }
  }

  if (assigneeId) {
    properties.Assignee = { people: [{ object: "user", id: assigneeId }] };
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
