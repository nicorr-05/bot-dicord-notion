import { EmbedBuilder } from "discord.js";
import {
  ensureNotifiedProperty,
  fetchCompletedUnnotifiedTickets,
  markTicketNotified,
} from "./notion.js";

const DEFAULT_INTERVAL_MINUTES = 5;

/** Channel the announcement falls back to when a ticket has no usable thread. */
const FALLBACK_CHANNEL_NAME = "bug-reports";

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
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle("✅ Bug resuelto")
    .setURL(ticket.url)
    .setDescription(`**${ticket.title}**`)
    .addFields({
      name: "Estado",
      value: ticket.status ?? "Done",
      inline: true,
    })
    .setFooter({
      text: inThread
        ? "Si el problema sigue, escríbelo aquí en el hilo."
        : "Si el problema sigue, abre un hilo nuevo en #bug-reports.",
    });

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

  const mention = ticket.reporterDiscordId
    ? `<@${ticket.reporterDiscordId}>`
    : ticket.reporterName;

  let content;
  if (thread) {
    content = mention
      ? `🎉 ${mention} ¡tu reporte ya está resuelto!`
      : "🎉 ¡Este reporte ya está resuelto!";
  } else {
    content = mention
      ? `🎉 ${mention} el bug que reportaste ya está resuelto:`
      : "🎉 Un bug reportado ya está resuelto:";
  }

  await target.send({
    content,
    embeds: [buildEmbed(ticket, { inThread: Boolean(thread) })],
    allowedMentions: ticket.reporterDiscordId
      ? { users: [ticket.reporterDiscordId] }
      : { parse: [] },
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
