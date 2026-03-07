import { SlashCommandBuilder, ChannelType } from "discord.js";
import { analyzeThread } from "../services/openai.js";
import { createTicket } from "../services/notion.js";

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

  // Sort oldest → newest and filter out bot messages and the /ticket command itself
  return allMessages
    .filter((m) => !m.author.bot && !m.content.startsWith("/"))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => ({
      author: m.author.username,
      content: m.content,
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

  // Optional: enforce that it's only used in bug-reports threads
  const parentChannel = channel.parent;
  if (parentChannel?.name !== "bug-reports") {
    return interaction.reply({
      content: `❌ This command only works in threads under **#bug-reports**. This thread is under **#${parentChannel?.name}**.`,
      ephemeral: true,
    });
  }

  // Defer so Discord doesn't time out (AI + Notion can take a few seconds)
  await interaction.deferReply();

  try {
    // 1. Fetch all messages from the thread
    const messages = await fetchAllMessages(channel);

    if (messages.length === 0) {
      return interaction.editReply(
        "❌ No messages found in this thread to analyze."
      );
    }

    // 2. Analyze with OpenAI
    await interaction.editReply("🤖 Analyzing thread with AI...");
    const analysis = await analyzeThread(channel.name, messages);

    // 3. Create ticket in Notion
    await interaction.editReply("📝 Creating ticket in Notion...");
    const threadUrl = `https://discord.com/channels/${interaction.guildId}/${channel.id}`;

    const notionPage = await createTicket({
      title: analysis.title,
      description: analysis.description,
      priority: analysis.priority,
      stepsToReproduce: analysis.stepsToReproduce,
      reporterName: interaction.user.username,
      threadUrl,
    });

    // 4. Success response
    return interaction.editReply(
      `✅ **Ticket created successfully!**\n\n` +
      `**Title:** ${analysis.title}\n` +
      `**Priority:** ${analysis.priority}\n` +
      `**Notion:** ${notionPage.url}\n\n` +
      `*${messages.length} messages analyzed.*`
    );
  } catch (error) {
    console.error("[/ticket] Error:", error);
    return interaction.editReply(
      `❌ Something went wrong: ${error.message}\n\nCheck the bot logs for details.`
    );
  }
}
