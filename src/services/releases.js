import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { fetchPageText } from "./notion.js";
import { mentionFor, mentionList } from "./discord-identity.js";
import { summarizeRelease } from "./openai.js";

/**
 * Colour and wording per task type. "Bug resuelto" and "nueva función" read very
 * differently to whoever is reading #releases, so the announcement never uses one
 * wording for everything.
 */
const TASK_TYPE_STYLE = {
  "🐞 Bug": { color: 0x57f287, label: "Arreglo", lead: "Arreglado", banner: "🐞 **Bug resuelto**" },
  "💬 Feature request": { color: 0x5865f2, label: "Novedad", lead: "Nuevo", banner: "✨ **Nueva función**" },
  "💅 Polish": { color: 0xeb459e, label: "Mejora", lead: "Mejorado", banner: "💅 **Mejora**" },
};

const DEFAULT_STYLE = {
  color: 0x5865f2,
  label: "Cambio",
  lead: "Listo",
  banner: "📦 **Nuevo cambio**",
};

function styleFor(taskType) {
  return TASK_TYPE_STYLE[taskType] ?? DEFAULT_STYLE;
}

/**
 * Discord's per-message upload cap by guild boost tier, in bytes.
 * Reading the tier matters: hard-coding 10 MB would reject videos a boosted
 * server accepts, and hard-coding 100 MB would make every upload fail late.
 */
const UPLOAD_LIMIT_BY_TIER = [10, 10, 50, 100].map((mb) => mb * 1024 * 1024);

function uploadLimitFor(channel) {
  const tier = Number(channel?.guild?.premiumTier) || 0;
  return UPLOAD_LIMIT_BY_TIER[tier] ?? UPLOAD_LIMIT_BY_TIER[0];
}

/** Links Discord can unfurl into a player on its own. */
const EMBEDDABLE_VIDEO_HOSTS =
  /(^|\.)(loom\.com|youtube\.com|youtu\.be|vimeo\.com|drive\.google\.com|streamable\.com)$/i;

const VIDEO_EXTENSION = /\.(mp4|mov|webm|m4v)(?:$|\?)/i;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)(?:$|\?)/i;

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * "video" | "image" | null.
 *
 * The MIME type wins when there is one: a file uploaded to Notion is served from
 * a signed URL that carries no extension, so the name is the only other clue and
 * it can be missing too.
 */
export function mediaTypeOf(media) {
  // Most tickets carry nothing at all, and a default parameter would not catch
  // it: `= {}` only fills in for undefined, never for null.
  if (!media) return null;

  const { name, url, contentType } = media;
  if (contentType?.startsWith("video/")) return "video";
  if (contentType?.startsWith("image/")) return "image";

  for (const candidate of [name, pathOf(url)].filter(Boolean)) {
    if (VIDEO_EXTENSION.test(candidate)) return "video";
    if (IMAGE_EXTENSION.test(candidate)) return "image";
  }
  return null;
}

function isEmbeddableLink(url) {
  try {
    return EMBEDDABLE_VIDEO_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function megabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * A safe, descriptive attachment name. The extension is not cosmetic: Discord
 * decides whether to render a player, an image or an inert file from it, so
 * getting it wrong turns a screenshot into an unopenable download.
 */
function attachmentName(ticket, media, contentType) {
  const fromName = [media.name, pathOf(media.url)]
    .filter(Boolean)
    .map((c) => c.match(VIDEO_EXTENSION)?.[1] ?? c.match(IMAGE_EXTENSION)?.[1])
    .find(Boolean);

  const fromMime = contentType?.split(";")[0]?.split("/")[1];
  const extension = (fromName ?? fromMime ?? "mp4").toLowerCase();

  const slug =
    ticket.title
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "release";

  return `${slug}.${extension}`;
}

/**
 * Downloads the file so it can be re-uploaded to Discord. Aborts as soon as the
 * declared size is over the limit, so a 2 GB file isn't pulled down just to be
 * rejected.
 */
async function downloadMedia(media, limitBytes) {
  const response = await fetch(media.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limitBytes) {
    response.body?.cancel();
    throw new Error(
      `pesa ${megabytes(declared)} MB y el límite del servidor es ${megabytes(limitBytes)} MB`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > limitBytes) {
    throw new Error(
      `pesa ${megabytes(buffer.byteLength)} MB y el límite del servidor es ${megabytes(limitBytes)} MB`
    );
  }

  return { buffer, contentType: response.headers.get("content-type") };
}

/**
 * Decides how the attached file reaches Discord.
 *
 *   · video — re-uploaded; Discord renders a player above the embed
 *   · image — shown inside the embed itself, which reads far better than an
 *             image dangling above the card
 *   · link  — posted as a follow-up so Discord unfurls its own preview
 *   · none  — nothing usable; the release still goes out without it
 *
 * A Notion-hosted file can only ever be re-uploaded: its URL is signed and
 * expires within the hour, so posting the link would publish a dead one.
 */
async function prepareMedia(ticket, channel) {
  const media = ticket.media;
  if (!media) return { kind: "none" };

  const hinted = mediaTypeOf(media);

  // An external image needs no download at all — the embed can point at its URL.
  if (media.kind === "external" && hinted === "image") {
    return { kind: "image", url: media.url };
  }

  if (media.kind === "hosted" || hinted !== null) {
    try {
      const { buffer, contentType } = await downloadMedia(
        media,
        uploadLimitFor(channel)
      );
      const name = attachmentName(ticket, media, contentType);
      const file = new AttachmentBuilder(buffer, { name });
      const type = mediaTypeOf({ ...media, contentType }) ?? "video";

      // attachment:// points the embed at a file uploaded in the same message.
      return type === "image"
        ? { kind: "image", file, url: `attachment://${name}` }
        : { kind: "video", file };
    } catch (error) {
      if (media.kind === "external") {
        console.warn(
          `[Releases] No se pudo re-subir el archivo de "${ticket.title}" (${error.message}); se publica como link.`
        );
        return { kind: "link", url: media.url };
      }
      // Notion-hosted and unusable: the signed URL is not worth publishing.
      console.warn(
        `[Releases] El archivo de "${ticket.title}" ${error.message}. ` +
          "Se publica el release sin él; súbelo a Loom/YouTube y pega el link en «Video release»."
      );
      return { kind: "none" };
    }
  }

  if (isEmbeddableLink(media.url)) return { kind: "link", url: media.url };

  console.warn(
    `[Releases] El archivo de "${ticket.title}" no es un video ni una imagen que Discord ` +
      `sepa previsualizar (${media.url}); se publica igual como link.`
  );
  return { kind: "link", url: media.url };
}

/**
 * The release note when OpenAI is unavailable: the ticket's own "Task description"
 * section, which is what /ticket wrote there in the first place.
 */
function fallbackNote(ticket, pageText) {
  const section = pageText
    .split(/^## /m)
    .find((block) => /^task description/i.test(block));

  const body = section
    ? section.replace(/^task description\s*/i, "").trim()
    : pageText.split(/^## /m)[0].trim();

  return { headline: ticket.title, summary: body, details: [] };
}

/** Asks OpenAI for the release note, degrading to the ticket's own text on failure. */
export async function buildReleaseNote(ticket) {
  let pageText = "";
  try {
    pageText = await fetchPageText(ticket.pageId);
  } catch (error) {
    console.warn(
      `[Releases] No se pudo leer el contenido de "${ticket.title}": ${error.message}`
    );
  }

  try {
    const note = await summarizeRelease({
      title: ticket.title,
      taskType: ticket.taskType,
      description: ticket.descriptionText,
      pageText,
    });
    if (note.summary) return note;
  } catch (error) {
    console.warn(
      `[Releases] Resumen con IA falló para "${ticket.title}" (${error.message}); se usa el texto del ticket.`
    );
  }

  return fallbackNote(ticket, pageText);
}

/**
 * Notion's `Completed` is a date with no time. Handing "2026-09-07" to `new Date`
 * gives UTC midnight, which west of Greenwich displays as the 6th at 8 PM — the
 * release would be dated the day before it shipped. Midday has no such edge.
 */
function completedInstant(completedAt) {
  if (!completedAt) return new Date();
  const dateOnly = completedAt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateOnly) return new Date(completedAt);

  const [, year, month, day] = dateOnly;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

/**
 * Tags for the two people a release is about: who reported it and who resolved
 * it. These go inside the embed, which renders them as tags without notifying
 * anyone — the reporter is already pinged in their own thread.
 */
export async function resolvePeople(client, ticket) {
  const [reporter, assignees] = await Promise.all([
    mentionFor(client, {
      discordId: ticket.reporterDiscordId,
      notionId: ticket.reporterNotionId,
      name: ticket.reporterName ?? ticket.reporterNotionName,
    }),
    mentionList(client, ticket.assignees ?? []),
  ]);

  return { reporter, assignees };
}

/** How the footer describes what is attached, if anything. */
function mediaLabel(media) {
  if (media?.kind === "image") return " · 🖼️ con imagen";
  if (media?.kind === "video" || media?.kind === "link") return " · 🎥 con video";
  return "";
}

/** The embed announcing a single ticket in #releases. */
export function buildReleaseEmbed(ticket, note, { media = {}, people = {} }) {
  const style = styleFor(ticket.taskType);

  const description = [
    note.summary,
    note.details.length > 0 ? note.details.map((d) => `• ${d}`).join("\n") : null,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4096);

  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.lead}: ${note.headline}`.slice(0, 256))
    .setDescription(description || ticket.title)
    .setTimestamp(completedInstant(ticket.completedAt))
    .setFooter({ text: `DocGuía · Releases${mediaLabel(media)}` });

  // An image belongs inside the card; a video can only ever sit above it.
  if (media.kind === "image") embed.setImage(media.url);

  embed.addFields({ name: "Tipo", value: style.label, inline: true });

  if (ticket.areas.length > 0) {
    embed.addFields({
      name: ticket.areas.length > 1 ? "Áreas" : "Área",
      value: ticket.areas.join(" · ").slice(0, 1024),
      inline: true,
    });
  }

  if (people.reporter) {
    embed.addFields({
      name: "Reportado por",
      value: people.reporter.slice(0, 1024),
      inline: true,
    });
  }

  if (people.assignees) {
    embed.addFields({
      name: "Resuelto por",
      value: people.assignees.slice(0, 1024),
      inline: true,
    });
  }

  if (ticket.threadUrl) {
    embed.addFields({
      name: "Conversación original",
      value: `[Ver el hilo](${ticket.threadUrl})`,
    });
  }

  return embed;
}

/**
 * Announces one finished ticket in #releases.
 * @returns {Promise<{message: import("discord.js").Message, note: object}>}
 */
export async function publishRelease(channel, ticket) {
  const [note, media, people] = await Promise.all([
    buildReleaseNote(ticket),
    prepareMedia(ticket, channel),
    resolvePeople(channel.client, ticket),
  ]);

  const embed = buildReleaseEmbed(ticket, note, { media, people });

  // Discord renders content above attachments and attachments above embeds. Without
  // a line of content the reader meets the video before anything says what it is.
  const message = await channel.send({
    content: styleFor(ticket.taskType).banner,
    embeds: [embed],
    files: media.file ? [media.file] : [],
    allowedMentions: { parse: [] },
  });

  // A link can't ride along with a rich embed — Discord won't unfurl it. Sending
  // it right after keeps the preview, and it lands under the release it belongs to.
  if (media.kind === "link") {
    await channel.send({ content: media.url, allowedMentions: { parse: [] } });
  }

  return { message, note };
}
