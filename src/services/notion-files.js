import { notion, NOTION_VERSION } from "./notion-client.js";

/**
 * Thread attachments → blocks in a Notion page.
 *
 * Discord signs its CDN links with an expiry (`?ex=…`), so an image embedded by URL
 * goes blank in Notion about a day later. Each file is downloaded and re-uploaded
 * through Notion's File Upload API instead. A file that can't be uploaded (too big
 * for a single-part upload, Notion rejects the type, Discord download fails) falls
 * back to the old external link rather than being dropped.
 */

/** Notion's single-part upload limit on paid plans; free workspaces stop at 5 MB. */
const MAX_SINGLE_PART_BYTES = 20 * 1024 * 1024;

/** How many files are downloaded and uploaded at the same time. */
const UPLOAD_CONCURRENCY = 3;

/** "image/png; charset=binary" → "image/png". */
function baseContentType(contentType) {
  return String(contentType ?? "").split(";")[0].trim().toLowerCase();
}

/** image | video | audio | file — the Notion block a thread attachment becomes. */
export function attachmentKind(attachment) {
  const type = baseContentType(attachment.contentType);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * Uploads one Discord attachment to Notion.
 * @returns {Promise<string|null>} the file_upload id, or null when it couldn't be uploaded.
 */
export async function uploadAttachment(
  attachment,
  { client = notion, fetchImpl = fetch, apiKey = process.env.NOTION_API_KEY } = {}
) {
  if (attachment.size && attachment.size > MAX_SINGLE_PART_BYTES) {
    console.warn(
      `[Notion] "${attachment.name}" pesa ${Math.round(attachment.size / 1e6)} MB; se enlaza en vez de subirlo.`
    );
    return null;
  }

  try {
    const download = await fetchImpl(attachment.url);
    if (!download.ok) throw new Error(`Discord respondió ${download.status}`);
    const bytes = await download.arrayBuffer();
    if (bytes.byteLength > MAX_SINGLE_PART_BYTES) return null;

    const contentType =
      baseContentType(attachment.contentType) || "application/octet-stream";

    const upload = await client.request({
      path: "file_uploads",
      method: "post",
      body: { filename: attachment.name, content_type: contentType },
    });

    // The SDK always sends JSON, so the multipart "send" step goes through fetch.
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: contentType }), attachment.name);

    const sent = await fetchImpl(
      `https://api.notion.com/v1/file_uploads/${upload.id}/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Notion-Version": NOTION_VERSION,
        },
        body: form,
      }
    );
    if (!sent.ok) {
      throw new Error(`Notion respondió ${sent.status}: ${await sent.text()}`);
    }

    return upload.id;
  } catch (error) {
    console.warn(
      `[Notion] No se pudo subir "${attachment.name}", se enlaza desde Discord: ${error.message}`
    );
    return null;
  }
}

/** A block for an attachment: the uploaded file when there is one, else a link. */
export function evidenceBlock(attachment, fileUploadId) {
  const kind = attachmentKind(attachment);

  if (fileUploadId) {
    const source = { type: "file_upload", file_upload: { id: fileUploadId } };
    if (kind === "file") {
      return {
        object: "block",
        type: "file",
        file: { ...source, name: attachment.name },
      };
    }
    return { object: "block", type: kind, [kind]: source };
  }

  if (kind === "image" || kind === "video") {
    return {
      object: "block",
      type: kind,
      [kind]: { type: "external", external: { url: attachment.url } },
    };
  }

  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        { text: { content: `📎 ${attachment.name}`, link: { url: attachment.url } } },
      ],
    },
  };
}

/** Uploads every attachment (a few at a time) and returns one block per file, in order. */
export async function buildEvidenceBlocks(attachments, options = {}) {
  const ids = new Array(attachments.length).fill(null);
  let next = 0;

  const worker = async () => {
    while (next < attachments.length) {
      const index = next++;
      ids[index] = await uploadAttachment(attachments[index], options);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, attachments.length) }, worker)
  );

  return attachments.map((a, i) => evidenceBlock(a, ids[i]));
}
