import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

/**
 * Creates a bug ticket in the Notion database.
 * @param {object} ticket
 * @param {string} ticket.title
 * @param {string} ticket.description
 * @param {string} ticket.priority - "High" | "Low" | "Urgent"
 * @param {string} ticket.stepsToReproduce
 * @param {string} ticket.reporterName - Discord username of the person who ran /ticket
 * @param {string} ticket.threadUrl - URL of the Discord thread
 * @returns {Promise<{url: string, id: string}>}
 */
export async function createTicket(ticket) {
  const { title, description, priority, stepsToReproduce, reporterName, threadUrl } = ticket;

  const fullDescription = [
    `**Descripción:**\n${description}`,
    `\n**Pasos para reproducir:**\n${stepsToReproduce}`,
    `\n**Reportado por:** ${reporterName}`,
    `**Thread de Discord:** ${threadUrl}`,
  ].join("\n");

  const response = await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties: {
      // Title (Name)
      title: {
        title: [{ text: { content: title } }],
      },
      // Priority
      Priority: {
        select: { name: priority },
      },
      // Status
      Status: {
        status: { name: "Not started" },
      },
      // Text field — used for Discord thread link + reporter info
      Text: {
        rich_text: [
          {
            text: {
              content: `Discord thread: ${threadUrl}\nReported by: ${reporterName}`,
            },
          },
        ],
      },
    },
    // Page body (task description + steps to reproduce)
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
            { text: { content: `Reported by: ${reporterName}\nDiscord thread: ` } },
            {
              text: { content: threadUrl, link: { url: threadUrl } },
            },
          ],
        },
      },
    ],
  });

  return {
    id: response.id,
    url: response.url,
  };
}
