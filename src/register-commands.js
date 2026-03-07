/**
 * Run this script ONCE to register the /ticket slash command with Discord.
 * Usage: node src/register-commands.js
 */
import "dotenv/config";
import { REST, Routes } from "discord.js";
import * as ticketCommand from "./commands/ticket.js";

const commands = [ticketCommand.data.toJSON()];

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
