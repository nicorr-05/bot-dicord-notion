/**
 * Discord ↔ Notion identity table.
 *
 * The two accounts aren't linked anywhere, so this file is the source of truth in
 * both directions:
 *   · creating a ticket  — Discord user → Notion person, for the "Reporter" property
 *   · announcing a fix   — Notion person → Discord id, so the @mention actually pings
 *
 * Lookups go by id; the names are here so the file stays readable. A row with
 * `discordId: null` is a known person we simply can't ping yet — the bot degrades
 * to plain text instead of guessing.
 *
 * To add someone: run `npm run users:audit` — it lists who is missing and prints the
 * rows to paste here. The bot also runs that audit on startup and once a day,
 * pairs people whose names match exactly on both sides (in memory), and reports
 * the rest in DISCORD_ADMIN_CHANNEL_ID.
 */
export const USER_LINKS = [
  // Ya no está en el workspace de Notion; se conserva para etiquetarlo en sus tickets viejos.
  {
    notionId: "05d0c0ff-90f7-4502-81c3-93b27badf814",
    notionName: "miguel luzardo",
    discordId: "1348719368527286303",
    discordUsername: "dr.miguelluzardo",
  },
  {
    notionId: "224d872b-594c-812f-ba90-0002f9c1f921",
    notionName: "Carlos Mayaudon",
    discordId: "1476613467069747323",
    discordUsername: "carlosmayaudon",
  },
  {
    notionId: "239d872b-594c-8179-b503-0002c2b29ba4",
    notionName: "Isaac",
    discordId: "610560695288856582",
    discordUsername: "const.isaac",
  },
  {
    notionId: "29ad872b-594c-81ac-878c-0002fcc2d699",
    notionName: "César Pérez",
    discordId: "1476210064481321033",
    discordUsername: "cesar.docguia",
  },
  {
    notionId: "34ad872b-594c-81f8-b265-00023df8e12a",
    notionName: "Diana Rivas",
    discordId: "779123703333650493",
    discordUsername: "cuarzo__",
  },
  {
    notionId: "3a4d872b-594c-81da-ae01-000248f54aec",
    notionName: "Emil Sanchez",
    discordId: "1031351573495939072",
    discordUsername: "emil10.s",
  },
  {
    notionId: "6b23c111-a02e-4b88-a84d-1e6d3107c40e",
    notionName: "Ramon Sanchez",
    discordId: "571451285111439382",
    discordUsername: "develat12.",
  },
  {
    notionId: "88a6d54a-5008-4372-90c4-55bf53e28d1b",
    notionName: "carlos parra",
    discordId: "1476229480589688995",
    discordUsername: "carlosparrayourfavoriteceo_39774",
  },
  {
    notionId: "9d1f08bd-26d1-4833-94aa-7ed1c5911853",
    notionName: "Nicolas Restrepo",
    discordId: "644160902983319593",
    discordUsername: "nicorr05",
  },
  {
    notionId: "361d872b-594c-815f-a985-00020c3242e0",
    notionName: "Francisco Ugas",
    discordId: "1352312584086360105",
    discordUsername: "fran053477",
  },
  {
    notionId: "3dbd872b-594c-81b6-9a2b-0002f5ffc20e",
    notionName: "sadiel matus",
    discordId: "750826639960834070",
    discordUsername: "sadiel.matus",
  },
  {
    notionId: "3ddd872b-594c-81a9-9f8c-0002c1f83c70",
    notionName: "Yender Alvarez",
    discordId: "1549859119207288882",
    discordUsername: "yenderdevdocguia",
  },
];

const byDiscordId = new Map();
const byNotionId = new Map();
const byDiscordUsername = new Map();

function index(link) {
  if (link.discordId) byDiscordId.set(link.discordId, link);
  if (link.notionId) byNotionId.set(link.notionId, link);
  if (link.discordUsername) {
    byDiscordUsername.set(link.discordUsername.toLowerCase(), link);
  }
}

USER_LINKS.forEach(index);

/**
 * Adds links found at runtime (see services/identity-sync.js). They live in memory
 * only; a row in USER_LINKS always wins over one added here.
 */
export function registerRuntimeLinks(links) {
  for (const link of links) {
    if (byDiscordId.has(link.discordId) || byNotionId.has(link.notionId)) continue;
    index(link);
  }
}

/** @returns {{notionId, notionName, discordId, discordUsername}|null} */
export function linkByDiscordId(discordId) {
  return byDiscordId.get(String(discordId)) ?? null;
}

/** @returns {{notionId, notionName, discordId, discordUsername}|null} */
export function linkByNotionId(notionId) {
  return byNotionId.get(String(notionId)) ?? null;
}

/** @returns {{notionId, notionName, discordId, discordUsername}|null} */
export function linkByDiscordUsername(username) {
  if (!username) return null;
  return byDiscordUsername.get(String(username).trim().toLowerCase()) ?? null;
}
