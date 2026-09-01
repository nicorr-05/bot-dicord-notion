import { EmbedBuilder } from "discord.js";
import {
  linkByDiscordUsername,
  linkByNotionId,
} from "../config/user-links.js";
import {
  ensureNotifiedProperty,
  fetchCompletedUnnotifiedTickets,
  markTicketNotified,
} from "./notion.js";

const DEFAULT_INTERVAL_MINUTES = 5;

/** Channel the announcement falls back to when a ticket has no usable thread. */
const FALLBACK_CHANNEL_NAME = "bug-reports";

const BUG_TASK_TYPE = "🐞 Bug";

/**
 * Wording per task type. A feature request announced as "Bug resuelto" reads as a
 * mistake, so bugs get the fix-it phrasing and everything else gets the shipped-it
 * phrasing.
 */
function wordingFor(taskType) {
  return taskType === BUG_TASK_TYPE
    ? {
        title: "✅ Bug resuelto",
        inThread: "¡tu reporte ya está resuelto!",
        inChannel: "el bug que reportaste ya está resuelto:",
        anonymous: "¡Este reporte ya está resuelto!",
        footer: "Si el problema sigue, escríbelo aquí en el hilo.",
      }
    : {
        title: "✅ Listo",
        inThread: "¡lo que pediste ya está listo!",
        inChannel: "lo que pediste ya está listo:",
        anonymous: "¡Esto ya está listo!",
        footer: null,
      };
}

/** Discord API error codes that mean the thread is gone for good. */
const GONE_ERROR_CODES = new Set([
  10003, // Unknown Channel
  10004, // Unknown Guild
]);

/**
 * Tickets whose notification failed for a non-recoverable reason (no permissions,
 * thread locked...). Kept in memory so a broken thread doesn't log an error every
 * poll — a bot restart retries them.
 */
const givenUp = new Set();

/** Resolved once per process — the channel lookup is a guild-wide fetch. */
let fallbackChannelPromise = null;

/** Discord username (lowercased) -> user id, or null when the lookup came up empty. */
const reporterIdCache = new Map();

/**
 * The #bug-reports channel, where tickets without a thread are announced.
 * Uses DISCORD_BUG_CHANNEL_ID when set, otherwise looks the channel up by name.
 */
function getFallbackChannel(client) {
  fallbackChannelPromise ??= (async () => {
    const configuredId = process.env.DISCORD_BUG_CHANNEL_ID;
    if (configuredId) return client.channels.fetch(configuredId);

    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const channels = await guild.channels.fetch();
    return (
      channels.find(
        (c) => c?.name === FALLBACK_CHANNEL_NAME && c.isTextBased?.()
      ) ?? null
    );
  })().catch((error) => {
    console.error(
      `[Watcher] No se pudo resolver el canal #${FALLBACK_CHANNEL_NAME}:`,
      error.message
    );
    fallbackChannelPromise = null; // let the next poll retry
    return null;
  });

  return fallbackChannelPromise;
}

function pollIntervalMs() {
  const minutes = Number(process.env.NOTION_POLL_INTERVAL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_INTERVAL_MINUTES) * 60_000;
}

function buildEmbed(ticket, { inThread }) {
  const wording = wordingFor(ticket.taskType);

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(wording.title)
    .setURL(ticket.url)
    .setDescription(`**${ticket.title}**`)
    .addFields({
      name: "Estado",
      value: ticket.status ?? "Done",
      inline: true,
    });

  if (ticket.taskType) {
    embed.addFields({ name: "Tipo", value: ticket.taskType, inline: true });
  }

  if (wording.footer) {
    embed.setFooter({
      text: inThread
        ? wording.footer
        : "Si el problema sigue, abre un hilo nuevo en #bug-reports.",
    });
  }

  // In the channel there is no surrounding conversation, so link back to it.
  if (!inThread && ticket.threadUrl) {
    embed.addFields({
      name: "Hilo original",
      value: `[Ver conversación](${ticket.threadUrl})`,
      inline: true,
    });
  }

  return embed;
}

/**
 * The Discord id to @mention, best source first:
 *
 *   1. the id the bot stored on the ticket        — tickets created with /ticket
 *   2. the identity table, via Notion's Reporter  — tickets opened by hand in Notion
 *   3. the identity table, via the username
 *   4. a guild search by username                 — someone not in the table yet
 *
 * Returns null when none of them land, and the announcement degrades to plain text
 * rather than pinging the wrong person.
 */
async function resolveReporterDiscordId(client, ticket) {
  if (ticket.reporterDiscordId) return ticket.reporterDiscordId;

  const fromNotion = linkByNotionId(ticket.reporterNotionId)?.discordId;
  if (fromNotion) return fromNotion;

  const fromUsername = linkByDiscordUsername(ticket.reporterName)?.discordId;
  if (fromUsername) return fromUsername;

  const name = ticket.reporterName?.trim();
  if (!name) return null;

  const key = name.toLowerCase();
  if (reporterIdCache.has(key)) return reporterIdCache.get(key);

  let id = null;
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const members = await guild.members.search({ query: name, limit: 10 });
    // Exact match only: `search` is a prefix search, and a near-miss would ping
    // the wrong person.
    const hit =
      members.find((m) => m.user.username.toLowerCase() === key) ??
      members.find((m) => m.displayName?.toLowerCase() === key);
    id = hit?.id ?? null;

    if (!id) {
      console.warn(
        `[Watcher] "${name}" no coincide con ningún miembro del server — aviso sin etiqueta.`
      );
    }
  } catch (error) {
    console.warn(
      `[Watcher] Falló la búsqueda de "${name}" en el server: ${error.message}`
    );
  }

  reporterIdCache.set(key, id);
  return id;
}

/**
 * Resolves the thread a ticket came from, or null when there is none to post in
 * (ticket opened by hand in Notion, thread deleted, link no longer a thread).
 */
async function resolveThread(client, ticket) {
  if (!ticket.threadId) return null;

  let channel;
  try {
    channel = await client.channels.fetch(ticket.threadId);
  } catch (error) {
    if (GONE_ERROR_CODES.has(error.code)) {
      console.warn(
        `[Watcher] Hilo ${ticket.threadId} ya no existe — aviso en #${FALLBACK_CHANNEL_NAME}.`
      );
      return null;
    }
    throw error;
  }

  if (!channel?.isThread?.()) return null;

  // Threads auto-archive after a few days; sending into one fails unless it is
  // reopened first. Without Manage Threads that call is denied — fall back to the
  // channel rather than dropping the notification.
  if (channel.archived) {
    try {
      await channel.setArchived(false);
    } catch (error) {
      console.warn(
        `[Watcher] No se pudo reabrir el hilo ${ticket.threadId} (${error.message}) — ` +
          `aviso en #${FALLBACK_CHANNEL_NAME}.`
      );
      return null;
    }
  }

  return channel;
}

/**
 * Posts the "ya está listo" message: in the original thread when the ticket has
 * one, otherwise in #bug-reports.
 * @returns {Promise<boolean>} true if the ticket should be marked as notified.
 */
async function notifyTicket(client, ticket) {
  const thread = await resolveThread(client, ticket);
  const target = thread ?? (await getFallbackChannel(client));

  if (!target) {
    throw new Error(
      `sin hilo y sin canal #${FALLBACK_CHANNEL_NAME} donde publicar`
    );
  }

  const reporterId = await resolveReporterDiscordId(client, ticket);
  const mention = reporterId
    ? `<@${reporterId}>`
    : ticket.reporterName ?? ticket.reporterNotionName;

  const wording = wordingFor(ticket.taskType);
  let content;
  if (!mention) {
    content = `🎉 ${wording.anonymous}`;
  } else if (thread) {
    content = `🎉 ${mention} ${wording.inThread}`;
  } else {
    content = `🎉 ${mention} ${wording.inChannel}`;
  }

  await target.send({
    content,
    embeds: [buildEmbed(ticket, { inThread: Boolean(thread) })],
    allowedMentions: reporterId ? { users: [reporterId] } : { parse: [] },
  });

  return true;
}

/** One polling pass: find completed tickets, announce them, tick the checkbox. */
async function poll(client) {
  const tickets = await fetchCompletedUnnotifiedTickets();
  const pending = tickets.filter((t) => !givenUp.has(t.pageId));
  if (pending.length === 0) return;

  console.log(`[Watcher] ${pending.length} ticket(s) completados por notificar.`);

  for (const ticket of pending) {
    try {
      if (await notifyTicket(client, ticket)) {
        await markTicketNotified(ticket.pageId);
        console.log(`[Watcher] Notificado: "${ticket.title}"`);
      }
    } catch (error) {
      givenUp.add(ticket.pageId);
      console.error(
        `[Watcher] No se pudo notificar "${ticket.title}" (hilo ${ticket.threadId}):`,
        error.message
      );
    }
  }
}

/**
 * Starts the Notion → Discord completion watcher.
 * Notion has no push events for this integration, so the database is polled.
 */
export async function startCompletionWatcher(client) {
  try {
    await ensureNotifiedProperty();
  } catch (error) {
    console.error(
      "[Watcher] No se pudo preparar la propiedad de control en Notion — " +
        "las notificaciones de completado quedan desactivadas:",
      error.message
    );
    return;
  }

  const intervalMs = pollIntervalMs();
  let running = false;

  const tick = async () => {
    if (running) return; // a slow pass must not overlap with the next one
    running = true;
    try {
      await poll(client);
    } catch (error) {
      console.error("[Watcher] Error consultando Notion:", error.message);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, intervalMs).unref?.();

  console.log(
    `🔔 Watcher de completados activo (revisa Notion cada ${intervalMs / 60_000} min)`
  );
}
