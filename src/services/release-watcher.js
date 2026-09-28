import {
  ensureReleaseProperties,
  fetchUnpublishedReleases,
  markReleasePublished,
} from "./notion.js";
import { getReleasesChannel } from "./discord-channels.js";
import { publishRelease } from "./releases.js";

const DEFAULT_INTERVAL_MINUTES = 5;

/**
 * Most releases a single poll may announce.
 *
 * A healthy week produces a handful. A number far above that means something went
 * wrong — an interrupted back-fill, or a batch of old tickets dragged to Done in
 * Notion — and publishing them would dump the backlog into the channel one message
 * at a time. The pass stops instead and says what to do about it.
 */
const DEFAULT_MAX_PER_POLL = 20;

function maxPerPoll() {
  const configured = Number(process.env.RELEASES_MAX_PER_POLL);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_PER_POLL;
}

/**
 * How long a ticket must sit untouched before it is announced.
 *
 * Marking a ticket Done and attaching its release video are two separate edits,
 * and nobody should have to remember which order they go in: waiting for the page
 * to go quiet means the announcement picks up whatever was added last. It also
 * buys a few minutes to fix a title before it is published to the whole server.
 *
 * Set RELEASES_QUIET_MINUTES=0 to announce on the next poll instead.
 */
const DEFAULT_QUIET_MINUTES = 10;

function quietPeriodMs() {
  const configured = Number(process.env.RELEASES_QUIET_MINUTES);
  const minutes =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : DEFAULT_QUIET_MINUTES;
  return minutes * 60_000;
}

/** Splits tickets into the ones ready to announce and the ones still being edited. */
export function partitionByQuietPeriod(tickets) {
  const quietMs = quietPeriodMs();
  if (quietMs === 0) return { ready: tickets, settling: [] };

  const cutoff = Date.now() - quietMs;
  const ready = [];
  const settling = [];

  for (const ticket of tickets) {
    const editedAt = Date.parse(ticket.lastEditedTime ?? "");
    // An unreadable timestamp shouldn't strand a release forever.
    if (!Number.isFinite(editedAt) || editedAt <= cutoff) ready.push(ticket);
    else settling.push(ticket);
  }

  return { ready, settling };
}

/**
 * Tickets whose release failed for a reason that won't fix itself on the next
 * poll. Kept in memory so one broken ticket doesn't log the same error every five
 * minutes — a bot restart retries them.
 */
const givenUp = new Set();

function pollIntervalMs() {
  const minutes = Number(process.env.NOTION_POLL_INTERVAL_MINUTES);
  return (
    (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES) *
    60_000
  );
}

/** One pass: publish every completed ticket that hasn't reached #releases yet. */
async function poll(client) {
  const tickets = await fetchUnpublishedReleases();
  const unannounced = tickets.filter((t) => !givenUp.has(t.pageId));
  if (unannounced.length === 0) return;

  const { ready: pending, settling } = partitionByQuietPeriod(unannounced);
  if (settling.length > 0) {
    console.log(
      `[Releases] ${settling.length} ticket(s) editados hace poco; se anuncian ` +
        `cuando se enfríen: ${settling.map((t) => `"${t.title}"`).join(", ")}`
    );
  }
  if (pending.length === 0) return;

  const limit = maxPerPoll();
  if (pending.length > limit) {
    console.error(
      `[Releases] ${pending.length} tickets sin anunciar, muy por encima de lo normal ` +
        `(máximo ${limit} por pasada). No se publica nada para no inundar el canal.\n` +
        "          · Si son tickets viejos: márcalos «Release publicado» en Notion y listo.\n" +
        "          · Si de verdad quieres anunciarlos todos: sube RELEASES_MAX_PER_POLL."
    );
    return;
  }

  const channel = await getReleasesChannel(client);
  if (!channel) {
    console.error(
      "[Releases] No hay canal de releases donde publicar; revisa DISCORD_RELEASES_CHANNEL_ID."
    );
    return;
  }

  console.log(`[Releases] ${pending.length} ticket(s) por anunciar.`);

  // Oldest first, so the channel reads in the order things actually shipped.
  const ordered = [...pending].sort((a, b) =>
    (a.completedAt ?? "").localeCompare(b.completedAt ?? "")
  );

  for (const ticket of ordered) {
    try {
      const { message, note } = await publishRelease(channel, ticket);
      // Marked only after the message is out: a crash in between re-announces the
      // ticket, which is far better than silently swallowing a release.
      await markReleasePublished(ticket.pageId, { messageUrl: message.url, note });
      console.log(`[Releases] Publicado: "${ticket.title}"`);
    } catch (error) {
      givenUp.add(ticket.pageId);
      console.error(`[Releases] No se pudo publicar "${ticket.title}":`, error.message);
    }
  }
}

/**
 * Starts the Notion → #releases watcher.
 * Notion has no push events for this integration, so the database is polled.
 */
export async function startReleaseWatcher(client) {
  try {
    await ensureReleaseProperties();
  } catch (error) {
    console.error(
      "[Releases] No se pudieron preparar las propiedades en Notion; " +
        "el canal de releases queda desactivado:",
      error.message
    );
    return false;
  }

  const intervalMs = pollIntervalMs();
  let running = false;

  const tick = async () => {
    if (running) return; // a slow pass must not overlap with the next one
    running = true;
    try {
      await poll(client);
    } catch (error) {
      console.error("[Releases] Error consultando Notion:", error.message);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, intervalMs).unref?.();

  const quietMinutes = quietPeriodMs() / 60_000;
  console.log(
    `🚀 Watcher de releases activo (revisa Notion cada ${intervalMs / 60_000} min` +
      (quietMinutes > 0
        ? `, anuncia tras ${quietMinutes} min sin editar el ticket)`
        : ", anuncia en la siguiente pasada)")
  );
  return true;
}
