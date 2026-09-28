import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { analyzeThread, precheckReport } from "../services/openai.js";
import {
  addTicketComment,
  createTicket,
  fetchTicketOptions,
  findSimilarTickets,
  resolveReporterId,
} from "../services/notion.js";
import { describeError } from "../lib/errors.js";
import { verdictLabel } from "../lib/duplicates.js";
import { checkTicketChannel } from "../lib/channels.js";
import {
  askOverrideReason,
  buildPrecheckBlocks,
  buildPrecheckComponents,
  buildPrecheckEmbed,
  precheckDeclinedMessage,
  precheckLevel,
} from "../lib/precheck.js";
import {
  fetchAllMessages,
  hasEnoughDescription,
  insufficientDescriptionMessage,
  replyEphemerallyAfterDefer,
} from "../lib/thread.js";

export const data = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Convierte este hilo de #bug-reports en un ticket de Notion con IA");

/** Two steps now (pre-check, then options), so more time than a single review. */
const REVIEW_TIMEOUT_MS = 5 * 60_000;

/** Discord's limit for a select option or button label. */
const LABEL_MAX = 100;

/** Notion keeps the priority names in English; the bot shows them in Spanish. */
const PRIORITY_ES = { urgent: "Urgente", critical: "Crítica", high: "Alta", medium: "Media", low: "Baja" };
const priorityLabel = (p) => PRIORITY_ES[String(p).toLowerCase()] ?? p;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** "[DG-387] Registro…" → "DG-387": short enough for a button next to "Crear ticket". */
const ticketCode = (title) => title.match(/^\[([A-Z]+-\d+)\]/)?.[1] ?? null;

/** "1 imagen · 2 videos", or null when the thread has no attachments. */
function describeEvidence({ images, videos, otherFiles }) {
  const parts = [
    [images.length, "🖼️", "imagen", "imágenes"],
    [videos.length, "🎬", "video", "videos"],
    [otherFiles.length, "📎", "archivo", "archivos"],
  ]
    .filter(([n]) => n > 0)
    .map(([n, icon, one, many]) => `${icon} ${n} ${n === 1 ? one : many}`);
  return parts.length ? parts.join(" · ") : null;
}

const defaultDeps = {
  fetchAllMessages,
  analyzeThread,
  precheckReport,
  fetchTicketOptions,
  findSimilarTickets,
  resolveReporterId,
  createTicket,
  addTicketComment,
};

export function makeExecute(deps = defaultDeps) {
  return (interaction) => run(interaction, deps);
}

export const execute = makeExecute();

async function run(interaction, deps) {
  const channel = interaction.channel;

  // Must be run inside a thread under #bug-reports (feature requests go to /feature)
  const allowed = checkTicketChannel(channel);
  if (!allowed.ok) {
    return interaction.reply({ content: allowed.message, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  try {
    // 1. Fetch messages
    const messages = await deps.fetchAllMessages(channel);
    if (messages.length === 0) {
      return interaction.editReply("❌ No encontré mensajes en este hilo para analizar.");
    }
    if (!hasEnoughDescription(messages)) {
      return replyEphemerallyAfterDefer(interaction, insufficientDescriptionMessage("bug"));
    }

    // 2. Analyze with AI + fetch Notion options in parallel
    await interaction.editReply("🤖 Analizando el hilo con IA...");
    // A failed pre-check only skips step 1; it never blocks the ticket.
    const [analysis, precheck, options] = await Promise.all([
      deps.analyzeThread(channel.name, messages),
      deps.precheckReport("bug", channel.name, messages).catch((error) => {
        console.warn("[/ticket] Pre-chequeo falló, se omite:", error.message);
        return null;
      }),
      deps.fetchTicketOptions(),
    ]);

    // The AI can return a priority that no longer exists in the DB schema —
    // snap it to a real option so the select menu and Notion agree.
    analysis.priority =
      options.priorityOptions.find(
        (p) => p.toLowerCase() === String(analysis.priority ?? "").toLowerCase()
      ) ??
      options.priorityOptions.find((p) => p.toLowerCase() === "medium") ??
      options.priorityOptions[0];

    // Is this bug already reported? Never blocks creating a new ticket.
    await interaction.editReply("🔎 Buscando tickets abiertos parecidos...");
    let matches = [];
    try {
      matches = await deps.findSimilarTickets(analysis);
    } catch (error) {
      console.warn("[/ticket] Duplicate search failed:", error);
    }

    // 3. Collect all attachments from the thread
    const allAttachments = messages.flatMap((m) => m.attachments || []);
    const images = allAttachments.filter((a) => a.contentType.startsWith("image/"));
    const videos = allAttachments.filter((a) => a.contentType.startsWith("video/"));
    const otherFiles = allAttachments.filter(
      (a) => !a.contentType.startsWith("image/") && !a.contentType.startsWith("video/")
    );

    // 4. Store pending selections. These are the values used if the reporter just
    //    hits "Create Ticket": AI priority, no sprint (= Backlog), default assignee.
    const userId = interaction.user.id;

    // Reporter = whoever ran /ticket. Discord and Notion accounts aren't linked,
    // so match on name (or an explicit env mapping) and let them fix it in the menu.
    const defaultReporterId = deps.resolveReporterId(
      userId,
      [
        interaction.member?.displayName,
        interaction.user.globalName,
        interaction.user.username,
      ],
      options.userOptions
    );

    // Who went ahead despite the pre-check and why; saved on the ticket.
    let override = null;

    const pending = {
      priority: analysis.priority,
      sprintId: null,
      assigneeId: options.defaultAssigneeId ?? null,
      reporterId: defaultReporterId,
    };

    // 5. Build select menus. Discord shows the chosen option instead of the
    //    placeholder, so every label says which field it is ("Asignado a: …"):
    //    otherwise assignee and reporter read as the same name twice.
    const priorityRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_priority_${userId}`)
        .setPlaceholder("Prioridad")
        .addOptions(
          options.priorityOptions.map((p) => ({
            label: `Prioridad: ${priorityLabel(p)}`,
            description: p === analysis.priority ? "Sugerida por la IA" : undefined,
            value: p,
            default: p === analysis.priority,
          }))
        )
    );

    // In Notion's native sprints the backlog is simply "no sprint", so it maps to
    // the "none" sentinel. It is the default: a bug reported mid-sprint is unplanned
    // work and shouldn't silently expand the running sprint's scope.
    const sprintChoices = [
      { label: "Sprint: Backlog (sin sprint)", value: "none", default: true },
      ...options.sprintOptions.slice(0, 24).map((s) => ({
        label: clip(`Sprint: ${s.name}${s.status ? ` (${s.status})` : ""}`, LABEL_MAX),
        value: s.id,
        default: false,
      })),
    ];

    const sprintRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_sprint_${userId}`)
        .setPlaceholder("Sprint")
        .addOptions(sprintChoices)
    );

    const assigneeChoices = options.userOptions.slice(0, 24).map((u) => ({
      label: clip(`Asignado a: ${u.name}`, LABEL_MAX),
      value: u.id,
      default: u.id === options.defaultAssigneeId,
    }));
    // Escape hatch so the default assignee can be cleared.
    assigneeChoices.push({
      label: "Asignado a: nadie",
      value: "none",
      default: !assigneeChoices.some((c) => c.default),
    });

    const assigneeRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_assignee_${userId}`)
        .setPlaceholder("Asignado a")
        .addOptions(assigneeChoices)
    );

    const reporterChoices = options.userOptions.slice(0, 24).map((u) => ({
      label: clip(`Reporta: ${u.name}`, LABEL_MAX),
      value: u.id,
      default: u.id === defaultReporterId,
    }));
    reporterChoices.push({
      label: "Reporta: nadie",
      value: "none",
      default: !reporterChoices.some((c) => c.default),
    });

    const reporterRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_reporter_${userId}`)
        .setPlaceholder("Reporta: ¿quién eres en Notion?")
        .addOptions(reporterChoices)
    );

    // One "same as" button per likely duplicate (max 3), so the five-row limit
    // still fits the four menus.
    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_create_${userId}`)
        .setLabel("Crear ticket")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      // The code alone keeps the row on one line; the full title is in the embed.
      ...matches.map((m, index) =>
        new ButtonBuilder()
          .setCustomId(`ticket_same_${index}_${userId}`)
          .setLabel(`Es el mismo que ${ticketCode(m.title) ?? clip(m.title, 40)}`)
          .setEmoji("🔗")
          .setStyle(ButtonStyle.Primary)
      ),
      new ButtonBuilder()
        .setCustomId(`ticket_cancel_${userId}`)
        .setLabel("Cancelar")
        .setStyle(ButtonStyle.Secondary)
    );

    // 6. Show embed with AI analysis + select menus
    const evidenceSummary = describeEvidence({ images, videos, otherFiles });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎫 Nuevo ticket de bug · Revisar y confirmar")
      .addFields(
        { name: "📌 Título", value: analysis.title },
        { name: "📝 Descripción", value: analysis.description },
        {
          name: "🔁 Pasos para reproducir",
          value: analysis.stepsToReproduce || "Sin especificar",
        },
        { name: "📎 Evidencia", value: evidenceSummary ?? "Sin adjuntos" }
      )
      .setFooter({ text: `${messages.length} mensajes analizados · Ajusta las opciones y pulsa Crear ticket` });

    if (matches.length > 0) {
      const list = matches
        .map(
          (m) =>
            `${verdictLabel(m.verdict)} · [${m.title}](${m.url}) · ${m.status ?? "sin estado"}` +
            (m.reason ? `\n  ↳ ${m.reason}` : "")
        )
        .join("\n");
      embed.addFields({
        name: "🔁 ¿Ya está reportado? Posibles duplicados",
        value: (
          list +
          "\n\n**¿Es otro bug?** → Crear ticket.\n" +
          "**¿Es otro caso del mismo bug?** → 🔗 Es el mismo que… (agrega este reporte como comentario)."
        ).slice(0, 1024),
      });
    }

    // Step 1 asks whether this is really a bug; step 2 is the review above.
    const review = {
      content: "",
      embeds: [embed],
      components: [priorityRow, sprintRow, assigneeRow, reporterRow, buttonRow],
    };

    const reply = await interaction.editReply(
      precheck
        ? {
            content: "",
            embeds: [buildPrecheckEmbed(precheck, { duplicateCount: matches.length })],
            components: buildPrecheckComponents({ prefix: "ticket", userId, precheck }),
          }
        : review
    );

    // 7. Collect component interactions across both steps
    const collector = reply.createMessageComponentCollector({
      filter: (i) => i.user.id === userId,
      time: REVIEW_TIMEOUT_MS,
    });

    collector.on("collect", async (i) => {
      if (
        i.customId === `ticket_precheck-yes_${userId}` ||
        i.customId === `ticket_precheck-no_${userId}`
      ) {
        const proceed = i.customId === `ticket_precheck-yes_${userId}`;
        const level = precheckLevel(precheck);
        if (proceed && level !== "ready") {
          // Skipping the warning takes a short reason; closing the modal keeps step 1.
          const reason = await askOverrideReason(i, { prefix: "ticket", userId, precheck });
          if (!reason || collector.ended) return;
          override = { reason, by: interaction.user.username };
        } else {
          await i.deferUpdate();
        }
        console.log(
          `[/ticket] Pre-chequeo: ${level} (${precheck.classification}), ` +
            `decisión: ${proceed ? "continuar" : "revisar"}` +
            (override ? `, razón de ${override.by}: ${override.reason}` : "")
        );
        if (proceed) return interaction.editReply(review);
        collector.stop("declined");
        return interaction.editReply({
          content: precheckDeclinedMessage(precheck),
          embeds: [],
          components: [],
        });
      } else if (i.customId === `ticket_priority_${userId}`) {
        pending.priority = i.values[0];
        await i.deferUpdate();
      } else if (i.customId === `ticket_sprint_${userId}`) {
        pending.sprintId = i.values[0] === "none" ? null : i.values[0];
        await i.deferUpdate();
      } else if (i.customId === `ticket_assignee_${userId}`) {
        pending.assigneeId = i.values[0] === "none" ? null : i.values[0];
        await i.deferUpdate();
      } else if (i.customId === `ticket_reporter_${userId}`) {
        pending.reporterId = i.values[0] === "none" ? null : i.values[0];
        await i.deferUpdate();
      } else if (i.customId === `ticket_create_${userId}`) {
        collector.stop("submitted");
        await i.deferUpdate();
        await interaction.editReply({
          content: "📝 Creando el ticket en Notion...",
          embeds: [],
          components: [],
        });

        const threadUrl = `https://discord.com/channels/${interaction.guildId}/${channel.id}`;
        const notionPage = await deps.createTicket({
          title: analysis.title,
          description: analysis.description,
          priority: pending.priority,
          stepsToReproduce: analysis.stepsToReproduce || "Sin especificar",
          reporterName: interaction.user.username,
          reporterDiscordId: userId,
          threadUrl,
          sprintId: pending.sprintId,
          sprintType: options.sprintType,
          assigneeId: pending.assigneeId,
          reporterId: pending.reporterId,
          attachments: allAttachments,
          precheckBlocks: buildPrecheckBlocks(precheck, override),
        });

        // Surface sprint/assignee too — both have defaults the reporter may not have touched.
        const sprintLabel =
          options.sprintOptions.find((sp) => sp.id === pending.sprintId)?.name ??
          "Backlog";
        const assigneeLabel =
          options.userOptions.find((u) => u.id === pending.assigneeId)?.name ??
          "nadie";
        const reporterLabel =
          options.userOptions.find((u) => u.id === pending.reporterId)?.name ??
          "nadie";

        await interaction.editReply(
          `✅ **Ticket creado**\n\n` +
            `**Título:** ${analysis.title}\n` +
            `**Prioridad:** ${priorityLabel(pending.priority)}\n` +
            `**Sprint:** ${sprintLabel}\n` +
            `**Asignado a:** ${assigneeLabel}\n` +
            `**Reporta:** ${reporterLabel}\n` +
            `**Notion:** ${notionPage.url}\n\n` +
            `*${messages.length} mensajes analizados.*`
        );
      } else if (i.customId.startsWith("ticket_same_")) {
        collector.stop("merged");
        await i.deferUpdate();
        const target = matches[Number(i.customId.split("_")[2])];
        await interaction.editReply({
          content: "🔗 Agregando este reporte al ticket existente...",
          embeds: [],
          components: [],
        });

        try {
          await deps.addTicketComment(target.id, {
            analysis,
            reporterName: interaction.user.username,
            threadUrl: `https://discord.com/channels/${interaction.guildId}/${channel.id}`,
            evidenceSummary,
          });
          await interaction.editReply(
            `🔗 **Agregado como nuevo caso de un ticket existente**\n\n` +
              `**Ticket:** ${target.title}\n` +
              `**Estado:** ${target.status ?? "sin estado"}\n` +
              `El reporte de este hilo quedó como comentario en la página.\n` +
              `**Notion:** ${target.url}`
          );
        } catch (error) {
          console.error("[/ticket] Error adding to existing ticket:", error);
          await interaction.editReply(describeError(error, { target: "la base de tickets" }));
        }
      } else if (i.customId === `ticket_cancel_${userId}`) {
        collector.stop("cancelled");
        await i.deferUpdate();
        await interaction.editReply({
          content: "Creación del ticket cancelada.",
          embeds: [],
          components: [],
        });
      }
    });

    collector.on("end", (_, reason) => {
      if (reason === "time") {
        interaction.editReply({
          content: "⏱️ Se acabó el tiempo. Vuelve a correr `/ticket`.",
          embeds: [],
          components: [],
        });
      }
    });
  } catch (error) {
    console.error("[/ticket] Error:", error);
    return interaction.editReply(describeError(error, { target: "la base de tickets" }));
  }
}
