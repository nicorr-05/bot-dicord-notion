/**
 * Lists who is missing from the Discord ↔ Notion identity table and prints the
 * rows to paste into src/config/user-links.js.
 * Usage: npm run users:audit
 */
import "dotenv/config";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { syncIdentities } from "./services/identity-sync.js";
import { formatAudit } from "./lib/identity-audit.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    console.log("🔎 Comparando usuarios de Notion y miembros de Discord...\n");
    console.log(formatAudit(await syncIdentities(client)));
  } catch (error) {
    console.error("❌ Falló la auditoría:", error.message);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
