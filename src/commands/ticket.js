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
  .setDescription("Converts this bug-report thread into a Notion ticket using AI");

/** Two steps now (pre-check, then options), so more time than a single review. */
const REVIEW_TIMEOUT_MS = 5 * 60_000;

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
      return interaction.editReply("❌ No messages found in this thread to analyze.");
    }
    if (!hasEnoughDescription(messages)) {
      return replyEphemerallyAfterDefer(interaction, insufficientDescriptionMessage("bug"));
    }

    // 2. Analyze with AI + fetch Notion options in parallel
    await interaction.editReply("🤖 Analyzing thread with AI...");
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
    await interaction.editReply("🔎 Looking for similar open tickets...");
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
    const defaultAssignee = options.userOptions.find(
      (u) => u.id === options.defaultAssigneeId
    );

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
    const defaultReporter = options.userOptions.find(
      (u) => u.id === defaultReporterId
    );

    // Who went ahead despite the pre-check and why; saved on the ticket.
    let override = null;

    const pending = {
      priority: analysis.priority,
      sprintId: null,
      assigneeId: options.defaultAssigneeId ?? null,
      reporterId: defaultReporterId,
    };

    // 5. Build select menus
    const priorityRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_priority_${userId}`)
        .setPlaceholder(`Priority — AI suggested: ${analysis.priority}`)
        .addOptions(
          options.priorityOptions.map((p) => ({
            label: p,
            value: p,
            default: p === analysis.priority,
          }))
        )
    );

    // In Notion's native sprints the backlog is simply "no sprint", so it maps to
    // the "none" sentinel. It is the default: a bug reported mid-sprint is unplanned
    // work and shouldn't silently expand the running sprint's scope.
    const sprintChoices = [
      { label: "📥 Backlog (sin sprint)", value: "none", default: true },
      ...options.sprintOptions.slice(0, 24).map((s) => ({
        label: s.status ? `${s.name} — ${s.status}` : s.name,
        value: s.id,
        default: false,
      })),
    ];

    const sprintRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_sprint_${userId}`)
        .setPlaceholder("Sprint — por defecto: Backlog")
        .addOptions(sprintChoices)
    );

    const assigneeChoices = options.userOptions.slice(0, 24).map((u) => ({
      label: u.name,
      value: u.id,
      default: u.id === options.defaultAssigneeId,
    }));
    // Escape hatch so the default assignee can be cleared.
    assigneeChoices.push({
      label: "Sin asignar",
      value: "none",
      default: !assigneeChoices.some((c) => c.default),
    });

    const assigneeRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_assignee_${userId}`)
        .setPlaceholder(
          defaultAssignee
            ? `Assignee — por defecto: ${defaultAssignee.name}`
            : "Select assignee..."
        )
        .addOptions(assigneeChoices)
    );

    const reporterChoices = options.userOptions.slice(0, 24).map((u) => ({
      label: u.name,
      value: u.id,
      default: u.id === defaultReporterId,
    }));
    reporterChoices.push({
      label: "Sin reporter",
      value: "none",
      default: !reporterChoices.some((c) => c.default),
    });

    const reporterRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`ticket_reporter_${userId}`)
        .setPlaceholder(
          defaultReporter
            ? `Reporter — detectado: ${defaultReporter.name}`
            : "Reporter — ¿quién eres en Notion?"
        )
        .addOptions(reporterChoices)
    );

    // One "same as" button per likely duplicate (max 3), so the five-row limit
    // still fits the four menus.
    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_create_${userId}`)
        .setLabel("✅ Create Ticket")
        .setStyle(ButtonStyle.Success),
      ...matches.map((m, index) =>
        new ButtonBuilder()
          .setCustomId(`ticket_same_${index}_${userId}`)
          .setLabel(`🔗 Same as: ${m.title}`.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
      ),
      new ButtonBuilder()
        .setCustomId(`ticket_cancel_${userId}`)
        .setLabel("❌ Cancel")
        .setStyle(ButtonStyle.Secondary)
    );

    // 6. Show embed with AI analysis + select menus
    const evidenceSummary =
      allAttachments.length > 0
        ? `🖼️ ${images.length} image(s)  🎬 ${videos.length} video(s)  📎 ${otherFiles.length} file(s)`
        : "None";

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎫 New Bug Ticket — Review & Confirm")
      .addFields(
        { name: "📌 Title", value: analysis.title },
        { name: "📝 Description", value: analysis.description },
        {
          name: "🔁 Steps to Reproduce",
          value: analysis.stepsToReproduce || "Not specified",
        },
        { name: "📎 Evidence found", value: evidenceSummary }
      )
      .setFooter({ text: `${messages.length} messages analyzed · Select options and click Create Ticket` });

    if (matches.length > 0) {
      const list = matches
        .map(
          (m) =>
            `${verdictLabel(m.verdict)} · [${m.title}](${m.url}) — ${m.status ?? "no status"}` +
            (m.reason ? `\n  ↳ ${m.reason}` : "")
        )
        .join("\n");
      embed.addFields({
        name: "🔁 Already reported? — possible duplicates",
        value: (
          list +
          "\n\n**Different bug?** → Create Ticket.\n" +
          "**New case of the same bug?** → 🔗 Same as… (adds this report as a comment)."
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
          content: "📝 Creating ticket in Notion...",
          embeds: [],
          components: [],
        });

        const threadUrl = `https://discord.com/channels/${interaction.guildId}/${channel.id}`;
        const notionPage = await deps.createTicket({
          title: analysis.title,
          description: analysis.description,
          priority: pending.priority,
          stepsToReproduce: analysis.stepsToReproduce || "Not specified",
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
          "Sin asignar";
        const reporterLabel =
          options.userOptions.find((u) => u.id === pending.reporterId)?.name ??
          "Sin reporter";

        await interaction.editReply(
          `✅ **Ticket created successfully!**\n\n` +
            `**Title:** ${analysis.title}\n` +
            `**Priority:** ${pending.priority}\n` +
            `**Sprint:** ${sprintLabel}\n` +
            `**Assignee:** ${assigneeLabel}\n` +
            `**Reporter:** ${reporterLabel}\n` +
            `**Notion:** ${notionPage.url}\n\n` +
            `*${messages.length} messages analyzed.*`
        );
      } else if (i.customId.startsWith("ticket_same_")) {
        collector.stop("merged");
        await i.deferUpdate();
        const target = matches[Number(i.customId.split("_")[2])];
        await interaction.editReply({
          content: "🔗 Adding this report to the existing ticket...",
          embeds: [],
          components: [],
        });

        try {
          await deps.addTicketComment(target.id, {
            analysis,
            reporterName: interaction.user.username,
            threadUrl: `https://discord.com/channels/${interaction.guildId}/${channel.id}`,
            evidenceSummary: allAttachments.length > 0 ? evidenceSummary : null,
          });
          await interaction.editReply(
            `🔗 **Added as a new case of an existing ticket**\n\n` +
              `**Ticket:** ${target.title}\n` +
              `**Status:** ${target.status ?? "—"}\n` +
              `This thread's report was added as a comment on the page.\n` +
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
          content: "❌ Ticket creation cancelled.",
          embeds: [],
          components: [],
        });
      }
    });

    collector.on("end", (_, reason) => {
      if (reason === "time") {
        interaction.editReply({
          content: "⏱️ Timed out. Run `/ticket` again.",
          embeds: [],
          components: [],
        });
      }
    });
  } catch (error) {
    console.error("[/ticket] Error:", error);
    return interaction.editReply(
      `❌ Something went wrong: ${error.message}\n\nCheck the bot logs for details.`
    );
  }
}
