/**
 * Channel lookup shared by the watchers.
 *
 * Resolving by name is a guild-wide fetch, so every result is cached for the life
 * of the process. A lookup that comes up empty is *not* cached — the channel may
 * simply not exist yet, and the next poll should try again.
 */

/** key -> Promise<Channel|null> */
const cache = new Map();

export function resolveTextChannel({ client, channelId, channelName }) {
  const key = channelId ?? `#${channelName}`;

  const cached = cache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    if (channelId) return client.channels.fetch(channelId);

    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const channels = await guild.channels.fetch();
    return (
      channels.find((c) => c?.name === channelName && c.isTextBased?.()) ?? null
    );
  })()
    .catch((error) => {
      console.error(`[Discord] No se pudo resolver el canal ${key}: ${error.message}`);
      return null;
    })
    .then((channel) => {
      if (!channel) cache.delete(key);
      return channel;
    });

  cache.set(key, pending);
  return pending;
}

/** The #releases channel: DISCORD_RELEASES_CHANNEL_ID, else the one named "releases". */
export function getReleasesChannel(client) {
  return resolveTextChannel({
    client,
    channelId: process.env.DISCORD_RELEASES_CHANNEL_ID || null,
    channelName: process.env.DISCORD_RELEASES_CHANNEL_NAME || "releases",
  });
}
