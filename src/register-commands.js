/**
 * Registers the /ticket and /feature slash commands with Discord.
 * Run it again whenever a command is added or its definition changes.
 * Usage: node src/register-commands.js
 */
import "dotenv/config";
import { REST, Routes } from "discord.js";
import * as ticketCommand from "./commands/ticket.js";
import * as featureCommand from "./commands/feature.js";

const commands = [ticketCommand.data.toJSON(), featureCommand.data.toJSON()];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log("🔄 Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );

    console.log("✅ Slash commands registered successfully!");
  } catch (error) {
    console.error("❌ Failed to register commands:", error);
  }
})();
