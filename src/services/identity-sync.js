import { USER_LINKS, registerRuntimeLinks } from "../config/user-links.js";
import { auditIdentities, formatAudit, isClean } from "../lib/identity-audit.js";
import { listWorkspaceUsers } from "./notion.js";
import { resolveTextChannel } from "./discord-channels.js";

/**
 * Keeps the Discord ↔ Notion identity table honest.
 *
 * On startup and once a day: compare both rosters with USER_LINKS, pair whoever
 * has the same name on both sides (in memory), and tell the team about the rest.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Characters the member search is seeded with — Discord's search is prefix-only. */
const SEARCH_PREFIXES = "abcdefghijklmnopqrstuvwxyz0123456789._".split("");

/**
 * Every guild member. Listing members needs the privileged Server Members intent,
 * which the bot doesn't have, so the roster is rebuilt from prefix searches — fine
 * for a team-sized server.
 */
export async function fetchGuildMembers(client) {
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const members = new Map();

  for (const query of SEARCH_PREFIXES) {
    const found = await guild.members.search({ query, limit: 1000 });
    for (const m of found.values()) {
      members.set(m.id, {
        id: m.id,
        username: m.user.username,
        globalName: m.user.globalName ?? null,
        nick: m.nickname ?? null,
        bot: m.user.bot,
      });
    }
  }

  return [...members.values()];
}

/** Runs the audit, applies the automatic pairs, and returns the result. */
export async function syncIdentities(client) {
  const [notionUsers, discordMembers] = await Promise.all([
    listWorkspaceUsers(),
    fetchGuildMembers(client),
  ]);

  const audit = auditIdentities({ notionUsers, discordMembers, links: USER_LINKS });
  registerRuntimeLinks(audit.autoLinks);
  return audit;
}

/** Where audit reports go: DISCORD_ADMIN_CHANNEL_ID, or nowhere (logs only). */
function adminChannel(client) {
  const channelId = process.env.DISCORD_ADMIN_CHANNEL_ID;
  return channelId ? resolveTextChannel({ client, channelId }) : Promise.resolve(null);
}

/**
 * Audits now and every day after. A report is posted only when it differs from
 * the last one, so an unresolved gap is announced once, not every morning.
 */
export async function startIdentitySync(client) {
  let lastReport = null;

  const run = async () => {
    try {
      const audit = await syncIdentities(client);
      const report = formatAudit(audit);

      for (const link of audit.autoLinks) {
        console.log(
          `[Identidad] Vinculado por nombre: ${link.notionName} ↔ @${link.discordUsername} (agrégalo a user-links.js)`
        );
      }
      if (isClean(audit)) {
        console.log("[Identidad] Todas las personas están vinculadas.");
        lastReport = null;
        return;
      }

      console.warn(`[Identidad] Hay vínculos pendientes:\n${report}`);
      if (report === lastReport) return;
      lastReport = report;

      const channel = await adminChannel(client);
      if (channel) {
        await channel.send({ content: report.slice(0, 2000), allowedMentions: { parse: [] } });
      }
    } catch (error) {
      console.error(`[Identidad] Falló la auditoría de usuarios: ${error.message}`);
    }
  };

  await run();
  setInterval(run, DAY_MS).unref?.();
}
