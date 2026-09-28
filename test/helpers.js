import { ChannelType } from "discord.js";

export const FEATURE_CHANNEL_ID = "1554218381953990798";

export function thread({ parentId = FEATURE_CHANNEL_ID, parentName = "feature-requests", messages = [] } = {}) {
  return {
    id: "thread-1",
    name: "Recordatorios por WhatsApp",
    type: ChannelType.PublicThread,
    parentId,
    parent: { id: parentId, name: parentName },
    messages: { fetch: async () => discordBatch(messages) },
  };
}

/** A Discord message collection with just what fetchAllMessages touches. */
function discordBatch(messages) {
  const entries = messages.map((m, i) => [
    String(i),
    {
      id: String(i),
      author: { username: m.author ?? "cesar.docguia", bot: false },
      content: m.content ?? "",
      createdTimestamp: i,
      attachments: new Map((m.attachments ?? []).map((a, j) => [String(j), a])),
    },
  ]);
  const batch = new Map(entries);
  batch.last = () => entries.at(-1)?.[1];
  return batch;
}

/** Records every reply and exposes the component collector so tests can click. */
export function fakeInteraction(channel) {
  const calls = { reply: [], editReply: [], followUp: [], deleteReply: 0, deferred: false };
  const handlers = {};
  const collector = {
    stoppedWith: null,
    on: (event, fn) => (handlers[event] = fn),
    stop(reason) {
      this.stoppedWith = reason;
      handlers.end?.(null, reason);
    },
  };

  const interaction = {
    channel,
    guildId: "guild-1",
    user: { id: "user-1", username: "cesar.docguia", globalName: "César" },
    member: { displayName: "César Pérez" },
    reply: async (msg) => calls.reply.push(msg),
    deferReply: async () => (calls.deferred = true),
    editReply: async (msg) => {
      calls.editReply.push(msg);
      return { createMessageComponentCollector: () => collector };
    },
    followUp: async (msg) => calls.followUp.push(msg),
    deleteReply: async () => calls.deleteReply++,
  };

  /** Simulates a click on a component and waits for its handler to finish. */
  const click = (action, values = []) =>
    handlers.collect({
      customId: `feature_${action}_${interaction.user.id}`,
      values,
      deferUpdate: async () => {},
    });

  const lastEdit = () => {
    const last = calls.editReply.at(-1);
    return typeof last === "string" ? last : last?.content;
  };

  return { interaction, calls, collector, click, lastEdit };
}

export const WELL_DESCRIBED = [
  {
    content:
      "La Dra. Pérez (pediatra) pide que los pacientes reciban un recordatorio de la cita por WhatsApp " +
      "el día anterior. Hoy su secretaria llama uno por uno y aun así tiene muchas inasistencias.",
  },
];
