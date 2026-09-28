import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { analyzeFeatureRequest } from "../services/openai.js";
import { listWorkspaceUsers, resolveReporterId } from "../services/notion.js";
import {
  addContextComment,
  createFeatureRequest,
  findSimilarFeatureRequests,
} from "../services/feature-requests.js";
import { checkFeatureChannel } from "../lib/channels.js";
import { describeError } from "../lib/errors.js";
import { verdictLabel } from "../lib/duplicates.js";
import {
  AREA_OPTIONS,
  DEFAULT_ORIGIN,
  ORIGIN_OPTIONS,
  PLATFORM_OPTIONS,
  truncate,
} from "../lib/feature-requests.js";
import {
  classifyAttachments,
  describeEvidence,
  fetchAllMessages,
  hasEnoughDescription,
  insufficientDescriptionMessage,
  replyEphemerallyAfterDefer,
  threadUrl as buildThreadUrl,
} from "../lib/thread.js";

export const data = new SlashCommandBuilder()
  .setName("feature")
  .setDescription("Convierte este thread de feature requests en una solicitud en Notion usando IA");

/** Reviewing a request takes longer than a bug: more fields to read and pick. */
const REVIEW_TIMEOUT_MS = 5 * 60_000;
const NOTION_TARGET = "la base de Feature Requests";

/** Discord's hard limits for embeds and select options. */
const FIELD_MAX = 1024;
const OPTION_MAX = 100;

const defaultDeps = {
  fetchAllMessages,
  analyzeFeatureRequest,
  listWorkspaceUsers,
  resolveReporterId,
  findSimilarFeatureRequests,
  createFeatureRequest,
  addContextComment,
};

/** The review embed: what the AI drafted, the evidence, and possible duplicates. */
export function buildReviewEmbed({ analysis, evidenceSummary, requesterName, matches, messageCount }) {
  const s = analysis.sections;
  const summary = [
    `**Quién lo pide:** ${s.quienLoPide}`,
    `**Cuántos lo han pedido:** ${s.cuantosLoHanPedido}`,
    `**Cómo lo resuelve hoy:** ${s.comoLoResuelveHoy}`,
    `**Qué pidió:** ${s.quePidioElMedico}`,
    `**Si no lo tenemos:** ${s.quePasaSiNo}`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(0xe8a33d)
    .setTitle("💡 Nueva solicitud — Revisar y confirmar")
    .setDescription(truncate(summary, 4000))
    .addFields(
      { name: "📌 Feature", value: truncate(analysis.title, FIELD_MAX) },
      { name: "🩺 Problema", value: truncate(analysis.problem, FIELD_MAX) },
      { name: "📎 Evidencia", value: evidenceSummary ?? "Sin adjuntos" },
      {
        name: "👤 Solicitado por",
        value: requesterName ?? "⚠️ No encontré tu usuario de Notion: el campo quedará vacío.",
      }
    )
    .setFooter({
      text: `${messageCount} mensajes analizados · Ajusta Origen, Área y Plataforma y confirma`,
    });

  if (matches.length > 0) {
    embed.addFields({
      name: "🔁 ¿Ya existe? — posibles solicitudes iguales",
      value: truncate(
        matches
          .map(
            (m) =>
              `${verdictLabel(m.verdict)} · **${m.code ?? "—"}** · [${m.title}](${m.url}) — ${m.stage ?? "Sin etapa"}` +
              (m.reason ? `\n↳ ${m.reason}` : "")
          )
          .join("\n") +
          "\n\n**¿Es diferente?** → Crear solicitud.\n" +
          "**¿Es otro caso de lo mismo?** → elige cuál abajo y usa **Agregar a existente**.",
        FIELD_MAX
      ),
    });
  }

  return embed;
}

/** Select menus and buttons, at most Discord's five rows. */
export function buildReviewComponents({ userId, state, analysis, matches }) {
  const select = (id) => new StringSelectMenuBuilder().setCustomId(`feature_${id}_${userId}`);

  const rows = [
    new ActionRowBuilder().addComponents(
      select("origin")
        .setPlaceholder("Origen")
        .addOptions(
          ORIGIN_OPTIONS.map((o) => ({ label: o, value: o, default: o === state.origin }))
        )
    ),
    new ActionRowBuilder().addComponents(
      select("area")
        .setPlaceholder("Área — elige una o varias")
        .setMinValues(0)
        .setMaxValues(AREA_OPTIONS.length)
        .addOptions(
          AREA_OPTIONS.map((a) => ({ label: a, value: a, default: state.areas.includes(a) }))
        )
    ),
    new ActionRowBuilder().addComponents(
      select("platform")
        .setPlaceholder(
          analysis.platform ? "Plataforma" : "Plataforma — la IA no encontró una en el thread"
        )
        .addOptions(
          PLATFORM_OPTIONS.map((p) => ({ label: p, value: p, default: p === state.platform }))
        )
    ),
  ];

  if (matches.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        select("match")
          .setPlaceholder("Solicitud existente")
          .addOptions(
            matches.map((m) => ({
              label: truncate(`${m.code ?? "—"} · ${m.title}`, OPTION_MAX),
              description: truncate(
                `${verdictLabel(m.verdict)} · ${m.stage ?? "Sin etapa"}`,
                OPTION_MAX
              ),
              value: m.id,
              default: m.id === state.matchId,
            }))
          )
      )
    );
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`feature_create_${userId}`)
      .setLabel("Crear solicitud")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
  ];
  if (matches.length > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`feature_existing_${userId}`)
        .setLabel("Agregar a existente")
        .setEmoji("🔗")
        .setStyle(ButtonStyle.Primary)
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`feature_cancel_${userId}`)
      .setLabel("Cancelar")
      .setStyle(ButtonStyle.Secondary)
  );
  rows.push(new ActionRowBuilder().addComponents(buttons));

  return rows;
}

export function makeExecute(deps = defaultDeps) {
  return async function execute(interaction) {
    const channel = interaction.channel;

    const allowed = checkFeatureChannel(channel);
    if (!allowed.ok) {
      return interaction.reply({ content: allowed.message, ephemeral: true });
    }

    await interaction.deferReply();

    let analysis, users, matches, messages;
    try {
      // 1. Read the thread and make sure there is something written to work from.
      messages = await deps.fetchAllMessages(channel);
      if (!hasEnoughDescription(messages)) {
        return replyEphemerallyAfterDefer(interaction, insufficientDescriptionMessage("feature"));
      }

      // 2. AI draft + Notion users.
      await interaction.editReply("🤖 Analizando el thread con IA...");
      [analysis, users] = await Promise.all([
        deps.analyzeFeatureRequest(channel.name, messages),
        deps.listWorkspaceUsers(),
      ]);
    } catch (error) {
      console.error("[/feature] Error:", error);
      return interaction.editReply(describeError(error, { target: NOTION_TARGET }));
    }

    // 3. Is it already in the backlog? Never blocks creating a new request.
    await interaction.editReply("🔎 Buscando solicitudes parecidas en Notion...");
    try {
      matches = await deps.findSimilarFeatureRequests(analysis);
    } catch (error) {
      console.warn("[/feature] No se pudo buscar duplicados:", error);
      matches = [];
    }

    // 4. Who asked, and what was attached.
    const userId = interaction.user.id;
    const requesterId = deps.resolveReporterId(
      userId,
      [interaction.member?.displayName, interaction.user.globalName, interaction.user.username],
      users
    );
    const requesterName = users.find((u) => u.id === requesterId)?.name ?? null;

    const evidence = classifyAttachments(messages);
    const evidenceSummary = describeEvidence(evidence);
    const threadUrl = buildThreadUrl(interaction.guildId, channel.id);

    const state = {
      origin: DEFAULT_ORIGIN,
      areas: analysis.areas,
      platform: analysis.platform,
      matchId: matches[0]?.id ?? null,
    };

    // 5. Review & confirm.
    const reply = await interaction.editReply({
      content: "",
      embeds: [
        buildReviewEmbed({
          analysis,
          evidenceSummary,
          requesterName,
          matches,
          messageCount: messages.length,
        }),
      ],
      components: buildReviewComponents({ userId, state, analysis, matches }),
    });

    const collector = reply.createMessageComponentCollector({
      filter: (i) => i.user.id === userId,
      time: REVIEW_TIMEOUT_MS,
    });

    const finish = (content) =>
      interaction.editReply({ content, embeds: [], components: [] });

    collector.on("collect", async (i) => {
      const action = i.customId.replace(/^feature_/, "").replace(`_${userId}`, "");

      if (action === "origin") state.origin = i.values[0];
      else if (action === "area") state.areas = [...i.values];
      else if (action === "platform") state.platform = i.values[0];
      else if (action === "match") state.matchId = i.values[0];

      if (!["create", "existing", "cancel"].includes(action)) {
        return i.deferUpdate();
      }

      // Stop first so a double click can't create two pages.
      collector.stop(action);
      await i.deferUpdate();

      if (action === "cancel") {
        return finish("❌ Solicitud cancelada.");
      }

      try {
        if (action === "existing") {
          const target = matches.find((m) => m.id === state.matchId) ?? matches[0];
          await finish(`🔗 Agregando contexto a **${target.code ?? target.title}**...`);
          await deps.addContextComment(target.id, {
            analysis,
            requesterName: requesterName ?? interaction.user.username,
            threadUrl,
            evidenceSummary,
          });
          return finish(
            `🔗 **Agregado a una solicitud existente${target.code ? ` · ${target.code}` : ""}**\n\n` +
              `**Feature:** ${target.title}\n` +
              `**Etapa:** ${target.stage ?? "Sin etapa"}\n` +
              `El contexto de este thread quedó como comentario en la página.\n` +
              `**Notion:** ${target.url}`
          );
        }

        await finish("📝 Creando la solicitud en Notion...");
        const page = await deps.createFeatureRequest({
          analysis,
          origin: state.origin,
          areas: state.areas,
          platform: state.platform,
          requesterId,
          requesterName: interaction.user.username,
          requesterDiscordId: userId,
          threadUrl,
          attachments: evidence.all,
        });

        return finish(
          `✅ **Solicitud creada${page.code ? ` · ${page.code}` : ""}**\n\n` +
            `**Feature:** ${analysis.title}\n` +
            `**Origen:** ${state.origin}\n` +
            `**Área:** ${state.areas.length ? state.areas.join(", ") : "Sin área"}\n` +
            `**Plataforma:** ${state.platform ?? "Sin definir"}\n` +
            `**Solicitado por:** ${requesterName ?? "Sin asignar"}\n` +
            `**Notion:** ${page.url}\n\n` +
            `*${messages.length} mensajes analizados. Producto decide prioridad, impacto y esfuerzo.*`
        );
      } catch (error) {
        console.error(`[/feature] Error en "${action}":`, error);
        return finish(describeError(error, { target: NOTION_TARGET }));
      }
    });

    collector.on("end", (_, reason) => {
      if (reason === "time") {
        finish("⏱️ Se acabó el tiempo para confirmar. Ejecuta `/feature` de nuevo.").catch(() => {});
      }
    });
  };
}

export const execute = makeExecute();
