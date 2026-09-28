import { ChannelType } from "discord.js";

/**
 * Where each command is allowed to run.
 *
 * #bug-reports is matched by name (as /ticket always did); the feature-requests
 * channel by id, since that is what the team configured.
 */
export const BUG_CHANNEL_NAME = "bug-reports";
const DEFAULT_FEATURE_CHANNEL_ID = "1554218381953990798";

export function featureChannelId() {
  return process.env.DISCORD_FEATURE_CHANNEL_ID || DEFAULT_FEATURE_CHANNEL_ID;
}

function isThread(channel) {
  return (
    channel?.type === ChannelType.PublicThread ||
    channel?.type === ChannelType.PrivateThread
  );
}

/** True for the feature-requests channel itself or any thread inside it. */
function inFeatureChannel(channel) {
  const id = featureChannelId();
  return channel?.id === id || channel?.parentId === id;
}

/**
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkTicketChannel(channel) {
  if (inFeatureChannel(channel)) {
    return {
      ok: false,
      message:
        `💡 Este canal es para solicitudes de funcionalidades: aquí se usa \`/feature\`.\n` +
        `Para reportar un bug, abre un thread en **#${BUG_CHANNEL_NAME}** y usa \`/ticket\` ahí.`,
    };
  }

  if (!isThread(channel)) {
    return {
      ok: false,
      message: "❌ This command must be used inside a thread in **#bug-reports**.",
    };
  }

  const parentName = channel.parent?.name;
  if (parentName !== BUG_CHANNEL_NAME) {
    return {
      ok: false,
      message: `❌ This command only works in threads under **#bug-reports**. This thread is under **#${parentName}**.`,
    };
  }

  return { ok: true };
}

/**
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function checkFeatureChannel(channel) {
  const channelMention = `<#${featureChannelId()}>`;

  if (!isThread(channel) || channel.parentId !== featureChannelId()) {
    return {
      ok: false,
      message:
        `❌ \`/feature\` solo funciona dentro de un thread de ${channelMention}.\n` +
        `Abre un thread ahí con la solicitud y ejecuta el comando dentro de él.`,
    };
  }

  return { ok: true };
}
