import { notion } from "./notion-client.js";
import { buildEvidenceBlocks } from "./notion-files.js";
import { judgeDuplicates } from "./openai.js";
import { findDuplicates } from "../lib/duplicates.js";
import {
  CLOSED_STAGES,
  FEATURE_PROP,
  buildContextComment,
  buildFeatureBody,
  buildFeatureProperties,
  formatCode,
  featureText,
  mapFeaturePage,
} from "../lib/feature-requests.js";

/**
 * The Feature Requests database. With API version 2022-06-28 pages are created
 * and queried by database id; its single data source is
 * collection://228b5ec5-590a-40f4-9ade-08374a2241b3.
 */
const FEATURE_DATABASE_ID =
  process.env.NOTION_FEATURES_DATABASE_ID || "8d1e8688d520433cbc37725ad9228cd5";

/** Notion accepts at most 100 blocks per create/append call. */
const BLOCKS_PER_REQUEST = 100;

/** Every request that isn't discarded or launched, following pagination. */
export async function fetchOpenFeatureRequests({ client = notion } = {}) {
  const pages = [];
  let cursor;

  do {
    const res = await client.databases.query({
      database_id: FEATURE_DATABASE_ID,
      // does_not_equal keeps pages with no stage at all, which are open too.
      filter: {
        and: CLOSED_STAGES.map((stage) => ({
          property: FEATURE_PROP.STAGE,
          select: { does_not_equal: stage },
        })),
      },
      page_size: 100,
      start_cursor: cursor,
    });
    pages.push(...res.results.map(mapFeaturePage));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return pages;
}

/**
 * Open requests that the AI considers the same need as this analysis, best first,
 * each with a `reason`. See lib/duplicates.js for the fallbacks.
 */
export async function findSimilarFeatureRequests(
  analysis,
  { client = notion, judge = judgeDuplicates } = {}
) {
  const pages = await fetchOpenFeatureRequests({ client });
  const { matches } = await findDuplicates({
    candidate: { title: analysis.title, summary: analysis.problem },
    items: pages.map((p) => ({ ...p, text: featureText(p) })),
    judge: judge && ((args) => judge({ kind: "feature", ...args })),
  });
  return matches;
}

/**
 * Creates the request page with its evidence re-uploaded to Notion.
 * @returns {Promise<{id: string, url: string, code: string|null}>}
 */
export async function createFeatureRequest(
  { analysis, origin, areas, platform, requesterId, requesterName, requesterDiscordId, threadUrl, attachments = [], precheckBlocks = [] },
  { client = notion, uploadEvidence = buildEvidenceBlocks } = {}
) {
  const properties = buildFeatureProperties({
    title: analysis.title,
    problem: analysis.problem,
    origin,
    areas,
    platform,
    requesterId,
  });

  const children = buildFeatureBody({
    sections: analysis.sections,
    requesterName,
    requesterDiscordId,
    threadUrl,
    evidenceBlocks: attachments.length ? await uploadEvidence(attachments) : [],
    precheckBlocks,
  });

  const page = await client.pages.create({
    parent: { database_id: FEATURE_DATABASE_ID },
    properties,
    children: children.slice(0, BLOCKS_PER_REQUEST),
  });

  for (let i = BLOCKS_PER_REQUEST; i < children.length; i += BLOCKS_PER_REQUEST) {
    await client.blocks.children.append({
      block_id: page.id,
      children: children.slice(i, i + BLOCKS_PER_REQUEST),
    });
  }

  return {
    id: page.id,
    url: page.url,
    code: formatCode(page.properties?.[FEATURE_PROP.CODE]?.unique_id),
  };
}

/** Adds the new doctor's context to an existing request as a page comment. */
export async function addContextComment(
  pageId,
  { analysis, requesterName, threadUrl, evidenceSummary },
  { client = notion } = {}
) {
  await client.comments.create({
    parent: { page_id: pageId },
    rich_text: buildContextComment({ analysis, requesterName, threadUrl, evidenceSummary }),
  });
}
