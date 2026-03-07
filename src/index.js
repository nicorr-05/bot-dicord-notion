import "dotenv/config";
import { Client, GatewayIntentBits, Collection } from "discord.js";
import * as ticketCommand from "./commands/ticket.js";

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

// ─── Events ───────────────────────────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ Bot ready! Logged in as ${client.user.tag}`);
  console.log(`📋 Watching for /ticket commands in #bug-reports threads`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`[interactionCreate] Error executing /${interaction.commandName}:`, error);
    const msg = { content: "❌ An unexpected error occurred.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg);
    } else {
      await interaction.reply(msg);
    }
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN);
