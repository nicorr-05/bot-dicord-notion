import { MessageFlags } from "discord.js";

/**
 * Reading a Discord thread for /ticket and /feature: the messages, their
 * attachments, and whether there is enough written text to work from.
 */

/** Where people learn how to write a bug report or a feature request. */
export const BUG_GUIDE_URL = "https://app.notion.com/p/3e98a66068d8815d9928c5a054caaee6";
export const FEATURE_GUIDE_URL = "https://app.notion.com/p/3e98a66068d8812f8aa0e781a63299be";

export function guideUrl(kind) {
  return kind === "feature" ? FEATURE_GUIDE_URL : BUG_GUIDE_URL;
}

/** Below this, a thread is "just a screenshot" and the AI would be guessing. */
const MIN_WORDS = 8;
const MIN_CHARS = 40;

/**
 * Fetches all messages from a thread (handles Discord's 100-msg pagination limit).
 */
export async function fetchAllMessages(thread) {
  const allMessages = [];
  let lastId = null;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch = await thread.messages.fetch(options);
    if (batch.size === 0) break;

    allMessages.push(...batch.values());
    lastId = batch.last().id;

    if (batch.size < 100) break;
  }

  return allMessages
    .filter((m) => !m.author.bot && !m.content.startsWith("/"))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => ({
      author: m.author.username,
      content: m.content,
      attachments: [...m.attachments.values()].map((a) => ({
        url: a.url,
        name: a.name,
        contentType: a.contentType || "",
        size: a.size ?? null,
      })),
    }));
}

/** Splits a thread's attachments into images, videos, audios and everything else. */
export function classifyAttachments(messages) {
  const all = messages.flatMap((m) => m.attachments || []);
  const is = (prefix) => (a) => a.contentType.startsWith(prefix);

  return {
    all,
    images: all.filter(is("image/")),
    videos: all.filter(is("video/")),
    audios: all.filter(is("audio/")),
    files: all.filter(
      (a) => !["image/", "video/", "audio/"].some((p) => a.contentType.startsWith(p))
    ),
  };
}

/** "🖼️ 2 imagen(es) · 🎬 1 video(s)…", or null when the thread has no files. */
export function describeEvidence({ all, images, videos, audios, files }) {
  if (all.length === 0) return null;
  return [
    images.length && `🖼️ ${images.length} imagen(es)`,
    videos.length && `🎬 ${videos.length} video(s)`,
    audios.length && `🎙️ ${audios.length} audio(s)`,
    files.length && `📎 ${files.length} archivo(s)`,
  ]
    .filter(Boolean)
    .join("  ");
}

export function threadUrl(guildId, threadId) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

/**
 * The words people actually wrote: links, mentions, custom and unicode emojis
 * stripped, so "📸 https://…" or "<@123> mira" doesn't pass for a description.
 */
export function writtenText(messages) {
  return messages
    .map((m) => m.content ?? "")
    .join("\n")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<a?:\w+:\d+>/g, " ") // custom emojis
    .replace(/<(@[!&]?|#)\d+>/g, " ") // user / role / channel mentions
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the thread has enough written text to turn into a ticket or request. */
export function hasEnoughDescription(messages) {
  const text = writtenText(messages);
  const words = text.split(" ").filter((w) => /\p{L}/u.test(w));
  return words.length >= MIN_WORDS && text.length >= MIN_CHARS;
}

/** The ephemeral nudge shown when a thread is only media or a couple of words. */
export function insufficientDescriptionMessage(kind) {
  const what = kind === "feature" ? "la solicitud" : "el bug";
  return (
    `✍️ Este thread no tiene suficiente texto para crear ${what}. ` +
    `Las imágenes, videos o audios ayudan, pero hace falta describirlo por escrito.\n\n` +
    `Escribe ${what} en el thread usando la plantilla de la guía y vuelve a ejecutar el comando:\n` +
    guideUrl(kind)
  );
}

/**
 * Swaps a public deferred reply for an ephemeral message. A deferred reply can't
 * change visibility, so it is deleted and the message goes out as a follow-up.
 */
export async function replyEphemerallyAfterDefer(interaction, content) {
  await interaction.deleteReply().catch(() => {});
  return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
}
