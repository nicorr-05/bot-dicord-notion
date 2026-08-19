import {
  SlashCommandBuilder,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { analyzeThread } from "../services/openai.js";
import { createTicket, fetchTicketOptions } from "../services/notion.js";

export const data = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Converts this bug-report thread into a Notion ticket using AI");

/**
 * Fetches all messages from a thread (handles Discord's 100-msg pagination limit).
 */
async function fetchAllMessages(thread) {
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
      })),
    }));
}

export async function execute(interaction) {
  const channel = interaction.channel;

  // Must be run inside a thread
  if (
    channel.type !== ChannelType.PublicThread &&
    channel.type !== ChannelType.PrivateThread
  ) {
    return interaction.reply({
      content: "❌ This command must be used inside a thread in **#bug-reports**.",
      ephemeral: true,
    });
  }

  // Enforce bug-reports channel
  const parentChannel = channel.parent;
  if (parentChannel?.name !== "bug-reports") {
    return interaction.reply({
      content: `❌ This command only works in threads under **#bug-reports**. This thread is under **#${parentChannel?.name}**.`,
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    // 1. Fetch messages
    const messages = await fetchAllMessages(channel);
    if (messages.length === 0) {
      return interaction.editReply("❌ No messages found in this thread to analyze.");
    }

    // 2. Analyze with AI + fetch Notion options in parallel
    await interaction.editReply("🤖 Analyzing thread with AI...");
    const [analysis, options] = await Promise.all([
      analyzeThread(channel.name, messages),
      fetchTicketOptions(),
    ]);

    // The AI can return a priority that no longer exists in the DB schema —
    // snap it to a real option so the select menu and Notion agree.
    analysis.priority =
      options.priorityOptions.find(
        (p) => p.toLowerCase() === String(analysis.priority ?? "").toLowerCase()
      ) ??
      options.priorityOptions.find((p) => p.toLowerCase() === "medium") ??
      options.priorityOptions[0];

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
    const pending = {
      priority: analysis.priority,
      sprintId: null,
      assigneeId: options.defaultAssigneeId ?? null,
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

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_create_${userId}`)
        .setLabel("✅ Create Ticket")
        .setStyle(ButtonStyle.Success),
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

    const reply = await interaction.editReply({
      embeds: [embed],
      components: [priorityRow, sprintRow, assigneeRow, buttonRow],
    });

    // 6. Collect component interactions (2 min timeout)
    const collector = reply.createMessageComponentCollector({
      filter: (i) => i.user.id === userId,
      time: 120_000,
    });

    collector.on("collect", async (i) => {
      if (i.customId === `ticket_priority_${userId}`) {
        pending.priority = i.values[0];
        await i.deferUpdate();
      } else if (i.customId === `ticket_sprint_${userId}`) {
        pending.sprintId = i.values[0] === "none" ? null : i.values[0];
        await i.deferUpdate();
      } else if (i.customId === `ticket_assignee_${userId}`) {
        pending.assigneeId = i.values[0] === "none" ? null : i.values[0];
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
        const notionPage = await createTicket({
          title: analysis.title,
          description: analysis.description,
          priority: pending.priority,
          stepsToReproduce: analysis.stepsToReproduce || "Not specified",
          reporterName: interaction.user.username,
          threadUrl,
          sprintId: pending.sprintId,
          sprintType: options.sprintType,
          assigneeId: pending.assigneeId,
          attachments: allAttachments,
        });

        await interaction.editReply(
          `✅ **Ticket created successfully!**\n\n` +
            `**Title:** ${analysis.title}\n` +
            `**Priority:** ${pending.priority}\n` +
            `**Notion:** ${notionPage.url}\n\n` +
            `*${messages.length} messages analyzed.*`
        );
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
