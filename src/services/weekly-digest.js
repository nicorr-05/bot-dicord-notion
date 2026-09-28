import { EmbedBuilder } from "discord.js";
import { fetchReleasesCompletedBetween } from "./notion.js";
import { getReleasesChannel } from "./discord-channels.js";
import { buildReleaseNote, mediaTypeOf } from "./releases.js";
import { mentionList } from "./discord-identity.js";
import {
  lastWeeklyOccurrence,
  parseTimeOfDay,
  parseWeekday,
  scheduleWeekly,
  shiftDateKey,
  zonedDateKey,
} from "../lib/schedule.js";

/**
 * How the digest recognises its own past messages. Written into the footer, so it
 * doubles as the label readers see — the bot needs no storage of its own to know
 * whether this week's digest already went out.
 */
const DIGEST_FOOTER = "DocGuía · Resumen semanal";

/** Days covered by each digest, counting back from the day it is sent. */
const WINDOW_DAYS = 7;

/**
 * How late a missed digest may still be sent on startup. A restart over the
 * scheduled minute should recover; a deploy on Tuesday should not suddenly post
 * last Friday's summary as if it were news.
 */
const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Order and wording of the sections, most interesting to the reader first. */
const SECTIONS = [
  { taskType: "💬 Feature request", emoji: "✨" },
  { taskType: "🐞 Bug", emoji: "🐞" },
  { taskType: "💅 Polish", emoji: "💅" },
];

const OTHER_EMOJI = "📦";

/**
 * Discord's embed limits: 25 fields, 256 characters per field name, 1024 per
 * value and 6000 across the whole embed. One ticket takes one field, so a heavy
 * week has to be trimmed rather than rejected by the API.
 */
const MAX_TICKET_FIELDS = 20;
const MAX_SUMMARY_CHARS = 300;
const MAX_EMBED_CHARS = 5500;

/**
 * Discord packs embed fields flush against each other, which turns a list of
 * seven releases into a wall of text. A zero-width space on its own line is the
 * only way to get an empty line: a plain trailing newline gets trimmed away.
 */
const SPACER = "\n\u200b";

/**
 * Summaries are written for the release message, where there is room to breathe.
 * In the digest they are cut at a sentence boundary when one is close enough, so
 * the line ends on a full stop instead of mid-word.
 */
function trimSummary(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_SUMMARY_CHARS) return clean;

  const cut = clean.slice(0, MAX_SUMMARY_CHARS);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  if (lastStop > MAX_SUMMARY_CHARS * 0.6) return cut.slice(0, lastStop + 1);

  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

function schedule() {
  return {
    weekday: parseWeekday(process.env.WEEKLY_DIGEST_WEEKDAY, "Fri"),
    ...parseTimeOfDay(process.env.WEEKLY_DIGEST_TIME, { hour: 15, minute: 30 }),
    timeZone: process.env.WEEKLY_DIGEST_TIMEZONE || "America/Caracas",
  };
}

/** Noon UTC, so the date can't slip a day when formatted in another zone. */
function middayOf(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/**
 * "del 5 al 11 de septiembre" — the month is only repeated when the week
 * actually straddles two of them.
 */
function humanRange(start, end, timeZone) {
  const dayOnly = new Intl.DateTimeFormat("es", { timeZone, day: "numeric" });
  const dayAndMonth = new Intl.DateTimeFormat("es", {
    timeZone,
    day: "numeric",
    month: "long",
  });

  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const from = sameMonth
    ? dayOnly.format(middayOf(start))
    : dayAndMonth.format(middayOf(start));

  return `del ${from} al ${dayAndMonth.format(middayOf(end))}`;
}

/** The Notion date range a digest sent on `sentAt` should cover. */
function windowFor(sentAt, timeZone) {
  const end = zonedDateKey(sentAt, timeZone);
  return { start: shiftDateKey(end, -(WINDOW_DAYS - 1)), end };
}

/**
 * Gives every ticket the two things the digest shows beyond its title: the copy,
 * and a tag for whoever resolved it.
 *
 * Tickets announced by the watcher already carry the summary that was published,
 * so the digest repeats the same wording for free. The ones that don't — closed
 * before this feature existed, or announced while OpenAI was down — are written
 * on the spot, up to a limit, so one catch-up week can't turn into a long burst
 * of API calls.
 */
async function prepareTickets(client, tickets, { maxGenerated = 12 } = {}) {
  let generated = 0;

  return Promise.all(
    tickets.map(async (ticket) => {
      const credit = await mentionList(client, ticket.assignees ?? []);

      if (ticket.storedNote?.summary) {
        return { ...ticket, credit, note: ticket.storedNote };
      }

      if (generated >= maxGenerated) {
        return { ...ticket, credit, note: { headline: ticket.title, summary: "" } };
      }
      generated += 1;

      try {
        return { ...ticket, credit, note: await buildReleaseNote(ticket) };
      } catch (error) {
        console.warn(
          `[Digest] Sin resumen para "${ticket.title}": ${error.message}`
        );
        return { ...ticket, credit, note: { headline: ticket.title, summary: "" } };
      }
    })
  );
}

/** The one-line footer under each ticket: who did it, and where to see it. */
function metaLine(ticket) {
  const parts = [];

  if (ticket.credit) parts.push(`👤 ${ticket.credit}`);

  const media = mediaTypeOf(ticket.media);
  const label =
    media === "image" ? "🖼️ Ver la imagen" : media ? "🎥 Ver el video" : "Ver el release";

  if (ticket.releaseMessageUrl) {
    parts.push(`[${label}](${ticket.releaseMessageUrl})`);
  } else if (ticket.media) {
    parts.push(media === "image" ? "🖼️ con imagen" : "🎥 con video");
  }

  return parts.join("  ·  ");
}

function sectionFor(taskType) {
  return SECTIONS.find((s) => s.taskType === taskType);
}

export function buildDigestEmbed(tickets, { start, end, timeZone }) {
  const range = humanRange(start, end, timeZone);

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("📦 Lo que salió esta semana")
    .setFooter({ text: DIGEST_FOOTER })
    .setTimestamp();

  if (tickets.length === 0) {
    return embed
      .setColor(0x99aab5)
      .setDescription(`No se cerró ningún ticket ${range}. La próxima semana seguimos.`);
  }

  // A ticket whose media type can't be read from the name still counts as a video,
  // which is what it is the overwhelming majority of the time.
  const attached = tickets.filter((t) => t.media);
  const images = attached.filter((t) => mediaTypeOf(t.media) === "image").length;
  const videos = attached.length - images;

  const description = [
    `**${tickets.length}** ${tickets.length === 1 ? "cambio" : "cambios"} ${range}.`,
    videos > 0 ? `🎥 ${videos} con video.` : null,
    images > 0 ? `🖼️ ${images} con imagen.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  embed.setDescription(description);

  // Grouped by type and, inside a type, in the order things were finished. The
  // emoji on each entry carries the grouping, so no section headers are needed.
  const ordered = [...tickets].sort((a, b) => {
    const rank = (t) => {
      const index = SECTIONS.findIndex((s) => s.taskType === t.taskType);
      return index === -1 ? SECTIONS.length : index;
    };
    return (
      rank(a) - rank(b) ||
      (a.completedAt ?? "").localeCompare(b.completedAt ?? "") ||
      a.title.localeCompare(b.title)
    );
  });

  let used = description.length + DIGEST_FOOTER.length + 40;
  let shown = 0;

  for (const ticket of ordered) {
    if (shown >= MAX_TICKET_FIELDS) break;

    const emoji = sectionFor(ticket.taskType)?.emoji ?? OTHER_EMOJI;
    const name = `${emoji} ${ticket.note?.headline || ticket.title}`.slice(0, 256);

    const value =
      ([trimSummary(ticket.note?.summary), metaLine(ticket)]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1024 - SPACER.length) || "Sin detalle") + SPACER;

    if (used + name.length + value.length > MAX_EMBED_CHARS) break;

    embed.addFields({ name, value });
    used += name.length + value.length;
    shown += 1;
  }

  const omitted = ordered.length - shown;
  if (omitted > 0) {
    embed.addFields({
      name: "​",
      value: `…y ${omitted} ${omitted === 1 ? "cambio más" : "cambios más"} esta semana.`,
    });
  }

  return embed;
}

/** True when a digest for this window is already sitting in the channel. */
async function alreadySent(channel, since) {
  const messages = await channel.messages.fetch({ limit: 50 });
  return messages.some(
    (m) =>
      m.author.id === channel.client.user.id &&
      m.createdTimestamp >= since.getTime() &&
      m.embeds.some((e) => e.footer?.text === DIGEST_FOOTER)
  );
}

async function sendDigest(client, sentAt, { skipIfAlreadySent = false } = {}) {
  const { timeZone } = schedule();
  const channel = await getReleasesChannel(client);

  if (!channel) {
    console.error(
      "[Digest] No hay canal de releases donde publicar el resumen; revisa DISCORD_RELEASES_CHANNEL_ID."
    );
    return;
  }

  if (skipIfAlreadySent && (await alreadySent(channel, sentAt))) {
    console.log("[Digest] El resumen de esta semana ya estaba publicado.");
    return;
  }

  const { start, end } = windowFor(sentAt, timeZone);
  const tickets = await prepareTickets(
    client,
    await fetchReleasesCompletedBetween(start, end)
  );

  await channel.send({
    embeds: [buildDigestEmbed(tickets, { start, end, timeZone })],
    allowedMentions: { parse: [] },
  });

  console.log(`[Digest] Resumen publicado: ${tickets.length} ticket(s) (${start} → ${end}).`);
}

/**
 * Starts the weekly digest. Defaults to Friday 15:30 in America/Caracas.
 *
 * On startup it also checks whether the most recent scheduled run was missed — a
 * deploy or a restart over the scheduled minute would otherwise skip a whole week
 * silently. The channel itself is the record of what was already sent, so no state
 * survives across restarts and nothing is ever posted twice.
 */
export async function startWeeklyDigest(client) {
  if (process.env.WEEKLY_DIGEST_ENABLED === "false") {
    console.log("📭 Resumen semanal desactivado (WEEKLY_DIGEST_ENABLED=false)");
    return;
  }

  const spec = schedule();

  try {
    const missed = lastWeeklyOccurrence(spec);
    if (Date.now() - missed.getTime() <= CATCH_UP_WINDOW_MS) {
      await sendDigest(client, missed, { skipIfAlreadySent: true });
    }
  } catch (error) {
    console.error("[Digest] No se pudo revisar el resumen pendiente:", error.message);
  }

  const { next } = scheduleWeekly(spec, (firedAt) => sendDigest(client, firedAt));

  console.log(
    `📅 Resumen semanal activo, próximo envío: ` +
      `${next.toLocaleString("es", { timeZone: spec.timeZone })} (${spec.timeZone})`
  );
}

export { prepareTickets };
