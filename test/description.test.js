import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUIDE_URL,
  hasEnoughDescription,
  insufficientDescriptionMessage,
} from "../src/lib/thread.js";
import { execute as ticketExecute } from "../src/commands/ticket.js";
import { fakeInteraction, thread } from "./helpers.js";

const msg = (content, attachments = []) => ({ content, attachments });
const image = { url: "https://cdn.discordapp.com/a.png", name: "a.png", contentType: "image/png" };

test("un thread con solo imágenes, videos o audios no alcanza", () => {
  assert.equal(hasEnoughDescription([msg("", [image]), msg("", [image])]), false);
});

test("texto muy corto no alcanza", () => {
  assert.equal(hasEnoughDescription([msg("mira esto"), msg("esto también 👀")]), false);
});

test("links, menciones y emojis no cuentan como descripción", () => {
  const noise = msg(
    "<@123456> <#987654> 🔥🔥🔥 https://docguia.com/agenda/semana/2026 https://loom.com/share/abc <:pepe:111>"
  );
  assert.equal(hasEnoughDescription([noise]), false);
});

test("una descripción real, aunque esté repartida en varios mensajes, alcanza", () => {
  assert.equal(
    hasEnoughDescription([
      msg("El doctor quiere exportar la historia clínica en PDF", [image]),
      msg("para mandársela al paciente por correo"),
    ]),
    true
  );
});

test("el mensaje de descripción insuficiente enlaza la guía", () => {
  assert.match(insufficientDescriptionMessage("feature"), /solicitud/);
  assert.match(insufficientDescriptionMessage("bug"), /bug/);
  for (const kind of ["feature", "bug"]) {
    assert.ok(insufficientDescriptionMessage(kind).includes(GUIDE_URL));
  }
});

test("/ticket también rechaza un thread sin texto, de forma efímera y sin llamar a la IA", async () => {
  const channel = thread({
    parentId: "bug-channel",
    parentName: "bug-reports",
    messages: [{ content: "", attachments: [image] }],
  });
  const { interaction, calls } = fakeInteraction(channel);

  await ticketExecute(interaction);

  assert.equal(calls.deleteReply, 1, "borra la respuesta pública diferida");
  assert.equal(calls.followUp.length, 1);
  assert.equal(calls.followUp[0].ephemeral, true);
  assert.ok(calls.followUp[0].content.includes(GUIDE_URL));
  assert.ok(
    !calls.editReply.some((m) => String(m).includes("Analyzing")),
    "no llega a la IA"
  );
});
