import "dotenv/config";
import { Client, GatewayIntentBits, Collection, Events, MessageFlags } from "discord.js";
import * as ticketCommand from "./commands/ticket.js";
import * as featureCommand from "./commands/feature.js";
import { startCompletionWatcher } from "./services/completion-watcher.js";
import { startReleaseWatcher } from "./services/release-watcher.js";
import { startWeeklyDigest } from "./services/weekly-digest.js";
import { startIdentitySync } from "./services/identity-sync.js";

// ─── Bot Setup ────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Register commands in a collection
client.commands = new Collection();
client.commands.set(ticketCommand.data.name, ticketCommand);
client.commands.set(featureCommand.data.name, featureCommand);

// ─── Events ───────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot ready! Logged in as ${client.user.tag}`);
  console.log(`📋 Watching for /ticket commands in #bug-reports threads`);
  console.log(`💡 Watching for /feature commands in feature-request threads`);

  // Pairs new teammates across Notion and Discord and reports who is left unlinked.
  // Not awaited: it takes a few seconds and nothing below depends on it.
  startIdentitySync(client);

  // Announces in Discord every bug that reaches a completed status in Notion.
  await startCompletionWatcher(client);

  // Publishes every finished ticket in #releases, with its video when it has one.
  const releasesReady = await startReleaseWatcher(client);

  // The Friday round-up only makes sense once the release columns exist.
  if (releasesReady) await startWeeklyDigest(client);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`[interactionCreate] Error executing /${interaction.commandName}:`, error);
    const msg = { content: "❌ An unexpected error occurred.", flags: MessageFlags.Ephemeral };
    // Telling the user can fail too: an interaction older than 3 s (bot restarting,
    // slow start) is already dead. That must never take the whole bot down.
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch (replyError) {
      console.warn(`[interactionCreate] No se pudo avisar del error: ${replyError.message}`);
    }
  }
});

// Without a listener, an "error" event (e.g. a rejected handler) crashes the process.
client.on(Events.Error, (error) => console.error("[client] Error:", error));
process.on("unhandledRejection", (error) => console.error("[process] Promesa sin manejar:", error));

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN);
