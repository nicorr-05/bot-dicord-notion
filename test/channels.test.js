import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { checkFeatureChannel, checkTicketChannel } from "../src/lib/channels.js";
import { makeExecute } from "../src/commands/feature.js";
import { execute as ticketExecute } from "../src/commands/ticket.js";
import { FEATURE_CHANNEL_ID, fakeInteraction, thread } from "./helpers.js";

const bugThread = thread({ parentId: "bug-channel", parentName: "bug-reports" });
const featureThread = thread();
const otherThread = thread({ parentId: "general", parentName: "general" });
const featureChannel = { id: FEATURE_CHANNEL_ID, type: ChannelType.GuildText, name: "feature-requests" };

test("/feature solo se permite en threads del canal de features", () => {
  assert.equal(checkFeatureChannel(featureThread).ok, true);

  for (const channel of [bugThread, otherThread, featureChannel]) {
    const result = checkFeatureChannel(channel);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes(`<#${FEATURE_CHANNEL_ID}>`));
  }
});

test("/feature fuera del canal responde efímero y no lee el thread", async () => {
  let fetched = false;
  const execute = makeExecute({ fetchAllMessages: async () => (fetched = true) });
  const { interaction, calls } = fakeInteraction(otherThread);

  await execute(interaction);

  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].ephemeral, true);
  assert.equal(calls.deferred, false);
  assert.equal(fetched, false);
});

test("/ticket en el canal de features avisa que los bugs van en #bug-reports", async () => {
  for (const channel of [featureThread, featureChannel]) {
    const result = checkTicketChannel(channel);
    assert.equal(result.ok, false);
    assert.match(result.message, /bug-reports/);
    assert.match(result.message, /\/feature/);
  }

  const { interaction, calls } = fakeInteraction(featureThread);
  await ticketExecute(interaction);
  assert.equal(calls.reply[0].ephemeral, true);
  assert.match(calls.reply[0].content, /bug-reports/);
});

test("/ticket mantiene sus reglas de siempre fuera del canal de features", () => {
  assert.equal(checkTicketChannel(bugThread).ok, true);
  assert.match(checkTicketChannel(otherThread).message, /This thread is under \*\*#general\*\*/);
  assert.match(
    checkTicketChannel({ id: "x", type: ChannelType.GuildText }).message,
    /must be used inside a thread/
  );
});
