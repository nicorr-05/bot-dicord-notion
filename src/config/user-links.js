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
 * To add someone: their Notion id comes from `GET https://api.notion.com/v1/users`,
 * their Discord id from right-clicking the user with Developer Mode on.
 */
export const USER_LINKS = [
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
    notionId: "325d872b-594c-81b8-a0e7-0002445a69b2",
    notionName: "gley ortiz",
    discordId: "771968766367105035",
    discordUsername: "gleydery",
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
  // ⚠️ Inferidos por nombre visible, no por coincidencia exacta — confirmar.
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
  // ⚠️ Sin pareja conocida — rellenar cuando se sepa.
  {
    notionId: "364d872b-594c-8183-8df9-00029cb04ae8",
    notionName: "Valentin Fuentes",
    discordId: null,
    discordUsername: null,
  },
  {
    notionId: null,
    notionName: null,
    discordId: "1512257981272817865",
    discordUsername: "andrespasante",
  },
];

const byDiscordId = new Map();
const byNotionId = new Map();
const byDiscordUsername = new Map();

for (const link of USER_LINKS) {
  if (link.discordId) byDiscordId.set(link.discordId, link);
  if (link.notionId) byNotionId.set(link.notionId, link);
  if (link.discordUsername) {
    byDiscordUsername.set(link.discordUsername.toLowerCase(), link);
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
