import { Client } from "@notionhq/client";

/**
 * The one Notion client the bot shares.
 *
 * It speaks the SDK's default API version (2022-06-28), where pages are created
 * and queried by `database_id`. That works because each database the bot writes
 * to has a single data source — adding a second one in Notion would make those
 * calls fail until the bot moves to 2025-09-03 and `data_source_id`.
 */
export const NOTION_VERSION = "2022-06-28";

export const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  notionVersion: NOTION_VERSION,
});
