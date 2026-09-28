import {
  linkByDiscordUsername,
  linkByNotionId,
} from "../config/user-links.js";

/**
 * Notion person → Discord user.
 *
 * Nothing links the two accounts, so this walks the sources in order of how much
 * they can be trusted and gives up rather than guessing: tagging the wrong
 * colleague in a public release is worse than showing a plain name.
 *
 * Note that a mention placed inside an embed renders as a tag but does not
 * notify anyone — only mentions in a message's content do. That is what lets the
 * release messages tag people without pinging them a second time.
 */

/** Normalized name → Discord id, or null when the lookup came up empty. */
const searchCache = new Map();

/**
 * Discord id for a person, best source first:
 *
 *   1. the id the bot itself stored on the ticket   — tickets created with /ticket
 *   2. the identity table, via the Notion person    — tickets opened by hand
 *   3. the identity table, via the name
 *   4. a guild search by name                       — someone not in the table yet
 *
 * @returns {Promise<string|null>}
 */
export async function resolveDiscordId(client, { discordId, notionId, name } = {}) {
  if (discordId) return discordId;

  const fromNotion = linkByNotionId(notionId)?.discordId;
  if (fromNotion) return fromNotion;

  const fromName = linkByDiscordUsername(name)?.discordId;
  if (fromName) return fromName;

  const query = name?.trim();
  if (!query) return null;

  const key = query.toLowerCase();
  if (searchCache.has(key)) return searchCache.get(key);

  let id = null;
  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const members = await guild.members.search({ query, limit: 10 });
    // Exact match only: `search` is a prefix search, and a near-miss would tag
    // the wrong person.
    const hit =
      members.find((m) => m.user.username.toLowerCase() === key) ??
      members.find((m) => m.displayName?.toLowerCase() === key);
    id = hit?.id ?? null;

    if (!id) {
      console.warn(
        `[Identidad] "${query}" no coincide con ningún miembro del server; se muestra el nombre sin etiquetar.`
      );
    }
  } catch (error) {
    console.warn(
      `[Identidad] Falló la búsqueda de "${query}" en el server: ${error.message}`
    );
  }

  searchCache.set(key, id);
  return id;
}

/**
 * How to name a person in a message: a tag when we can, their plain name when we
 * can't, and null when we don't even have that.
 */
export async function mentionFor(client, person) {
  const id = await resolveDiscordId(client, person);
  if (id) return `<@${id}>`;
  return person?.name?.trim() || null;
}

/** The same, for a list of people, joined for display. */
export async function mentionList(client, people = []) {
  const mentions = await Promise.all(
    people.map((person) => mentionFor(client, person))
  );
  const shown = mentions.filter(Boolean);
  return shown.length > 0 ? shown.join(" · ") : null;
}
