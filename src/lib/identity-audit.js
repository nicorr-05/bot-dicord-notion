1554228369678274580/**
 * Cross-checks Notion workspace users, Discord guild members and the identity
 * table (src/config/user-links.js), so a new teammate doesn't silently go
 * untagged in releases or unassigned as a reporter.
 *
 * Pure: the caller fetches both rosters. The rule for pairing two people without
 * a row in the table is deliberately narrow — the same normalized name on both
 * sides, and nobody else sharing it. Anything short of that is left for a human.
 */

/** "Sadiel.matus", "sadiel_matus" and "Sádiel Matus" all become "sadiel matus". */
export function nameKey(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // "Carlos Parra (your Favorite CEO)"
    .replace(/[._\-\s]+/g, " ")
    .trim();
}

/** Every name a Discord member goes by: handle, global display name, server nickname. */
function discordKeys(member) {
  return [...new Set([member.username, member.globalName, member.nick].map(nameKey).filter(Boolean))];
}

/**
 * @param {object} args
 * @param {Array<{id: string, name: string}>} args.notionUsers  workspace members
 * @param {Array<{id: string, username: string, globalName?: string, nick?: string, bot?: boolean}>} args.discordMembers
 * @param {Array<{notionId, notionName, discordId, discordUsername}>} args.links  the identity table
 */
export function auditIdentities({ notionUsers, discordMembers, links }) {
  const humans = discordMembers.filter((m) => !m.bot);
  const linkedNotion = new Set(links.map((l) => l.notionId).filter(Boolean));
  const linkedDiscord = new Set(links.map((l) => l.discordId).filter(Boolean));

  const freeNotion = notionUsers.filter((u) => !linkedNotion.has(u.id));
  const freeDiscord = humans.filter((m) => !linkedDiscord.has(m.id));

  // Name → the unlinked people on each side who go by it.
  const notionByKey = new Map();
  for (const u of freeNotion) {
    const key = nameKey(u.name);
    if (key) notionByKey.set(key, [...(notionByKey.get(key) ?? []), u]);
  }
  const discordByKey = new Map();
  for (const m of freeDiscord) {
    for (const key of discordKeys(m)) {
      discordByKey.set(key, [...(discordByKey.get(key) ?? []), m]);
    }
  }

  const autoLinks = [];
  const pairedNotion = new Set();
  const pairedDiscord = new Set();

  for (const [key, notionSide] of notionByKey) {
    const discordSide = discordByKey.get(key) ?? [];
    if (notionSide.length !== 1 || discordSide.length !== 1) continue;

    const [u] = notionSide;
    const [m] = discordSide;
    if (pairedNotion.has(u.id) || pairedDiscord.has(m.id)) continue;

    pairedNotion.add(u.id);
    pairedDiscord.add(m.id);
    autoLinks.push({
      notionId: u.id,
      notionName: u.name,
      discordId: m.id,
      discordUsername: m.username,
    });
  }

  const notionIds = new Set(notionUsers.map((u) => u.id));
  const discordIds = new Set(humans.map((m) => m.id));

  return {
    autoLinks,
    unmatchedNotion: freeNotion.filter((u) => !pairedNotion.has(u.id)),
    unmatchedDiscord: freeDiscord.filter((m) => !pairedDiscord.has(m.id)),
    // Rows whose people are gone from both sides — safe to delete.
    staleLinks: links.filter(
      (l) =>
        (!l.notionId || !notionIds.has(l.notionId)) &&
        (!l.discordId || !discordIds.has(l.discordId))
    ),
  };
}

/** A row ready to paste into USER_LINKS. */
export function linkRow({ notionId, notionName, discordId, discordUsername }) {
  const q = (v) => (v == null ? "null" : JSON.stringify(v));
  return (
    `  {\n` +
    `    notionId: ${q(notionId)},\n` +
    `    notionName: ${q(notionName)},\n` +
    `    discordId: ${q(discordId)},\n` +
    `    discordUsername: ${q(discordUsername)},\n` +
    `  },`
  );
}

/** True when there is nothing a human needs to do. */
export function isClean(audit) {
  return (
    audit.autoLinks.length === 0 &&
    audit.unmatchedNotion.length === 0 &&
    audit.unmatchedDiscord.length === 0 &&
    audit.staleLinks.length === 0
  );
}

/** The report, as plain text (Markdown-friendly for Discord and readable in a terminal). */
export function formatAudit(audit) {
  if (isClean(audit)) return "✅ Todas las personas de Notion y Discord están vinculadas.";

  const parts = ["👥 **Vínculos Notion ↔ Discord**"];

  if (audit.autoLinks.length) {
    parts.push(
      `\n🔗 **Vinculados automáticamente** por nombre (solo hasta el próximo reinicio). ` +
        `Pega estas filas en \`src/config/user-links.js\` para fijarlos:\n` +
        "```js\n" +
        audit.autoLinks.map(linkRow).join("\n") +
        "\n```"
    );
  }

  if (audit.unmatchedNotion.length) {
    parts.push(
      `\n❓ **En Notion sin pareja en Discord:**\n` +
        audit.unmatchedNotion.map((u) => `• ${u.name} — \`${u.id}\``).join("\n")
    );
  }

  if (audit.unmatchedDiscord.length) {
    parts.push(
      `\n❓ **En Discord sin pareja en Notion:**\n` +
        audit.unmatchedDiscord
          .map((m) => `• ${m.globalName ?? m.username} (@${m.username}) — \`${m.id}\``)
          .join("\n")
    );
  }

  if (audit.staleLinks.length) {
    parts.push(
      `\n🧹 **Filas que ya no están ni en Notion ni en Discord** (se pueden borrar):\n` +
        audit.staleLinks
          .map((l) => `• ${l.notionName ?? l.discordUsername ?? "(sin nombre)"}`)
          .join("\n")
    );
  }

  if (audit.unmatchedNotion.length || audit.unmatchedDiscord.length) {
    parts.push(
      "\nPara los que quedan sin pareja, agrega la fila a mano en `src/config/user-links.js` " +
        "(o `discordId: null` si no tiene Discord)."
    );
  }

  return parts.join("\n");
}
