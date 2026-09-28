import { test } from "node:test";
import assert from "node:assert/strict";
import { APIResponseError } from "@notionhq/client";
import { makeExecute } from "../src/commands/feature.js";
import { AIError } from "../src/lib/errors.js";
import { FEATURE_GUIDE_URL } from "../src/lib/thread.js";
import { normalizeFeatureAnalysis } from "../src/lib/feature-requests.js";
import { WELL_DESCRIBED, fakeInteraction, thread } from "./helpers.js";

const analysis = normalizeFeatureAnalysis({
  title: "Recordatorios de cita por WhatsApp para reducir inasistencias",
  problem: "Los pacientes faltan porque nadie les recuerda la cita.",
  areas: ["Agenda"],
  platform: "Web",
  sections: { quienLoPide: "Pediatra" },
});

const match = {
  id: "fr-1",
  code: "FR-3",
  title: "Recordatorios automáticos de citas",
  url: "https://notion.so/fr-1",
  stage: "🗣️ En discusión",
  score: 0.8,
  verdict: "same",
  reason: "Misma necesidad.",
};

/** Default fakes; each test overrides what it cares about and records calls. */
function deps(overrides = {}) {
  const calls = { create: [], comment: [], analyze: 0 };
  return {
    calls,
    deps: {
      fetchAllMessages: async () => WELL_DESCRIBED,
      analyzeFeatureRequest: async () => (calls.analyze++, analysis),
      // No pre-check by default: these tests start at the review step.
      precheckReport: async () => null,
      listWorkspaceUsers: async () => [{ id: "notion-cesar", name: "César Pérez" }],
      resolveReporterId: (discordId, names, users) => users[0].id,
      findSimilarFeatureRequests: async () => [match],
      createFeatureRequest: async (req) => {
        calls.create.push(req);
        return { id: "new", url: "https://notion.so/new", code: "FR-12" };
      },
      addContextComment: async (pageId, details) => calls.comment.push({ pageId, details }),
      ...overrides,
    },
  };
}

test("descripción insuficiente: mensaje efímero con la guía y sin IA", async () => {
  const { deps: d, calls } = deps({
    fetchAllMessages: async () => [
      { content: "", attachments: [{ url: "u", name: "a.mp4", contentType: "video/mp4" }] },
    ],
  });
  const fake = fakeInteraction(thread());

  await makeExecute(d)(fake.interaction);

  assert.equal(calls.analyze, 0);
  assert.equal(fake.calls.deleteReply, 1);
  assert.equal(fake.calls.followUp[0].ephemeral, true);
  assert.ok(fake.calls.followUp[0].content.includes(FEATURE_GUIDE_URL));
});

test("con duplicados, la revisión los muestra con botón y selector de Agregar a existente", async () => {
  const { deps: d } = deps();
  const fake = fakeInteraction(thread());

  await makeExecute(d)(fake.interaction);

  const review = fake.calls.editReply.find((m) => m.embeds);
  const embed = review.embeds[0].toJSON();
  const dup = embed.fields.find((f) => f.name.includes("¿Ya existe?"));
  assert.match(dup.value, /FR-3/);
  assert.match(dup.value, /Misma necesidad\./);

  const ids = review.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
  assert.deepEqual(ids, [
    "feature_origin_user-1",
    "feature_area_user-1",
    "feature_platform_user-1",
    "feature_match_user-1",
    "feature_create_user-1",
    "feature_existing_user-1",
    "feature_cancel_user-1",
  ]);

  const origin = review.components[0].toJSON().components[0].options.find((o) => o.default);
  assert.equal(origin.value, "Médicos / clientes");
});

test("Agregar a existente comenta en la solicitud elegida y no crea página", async () => {
  const { deps: d, calls } = deps();
  const fake = fakeInteraction(thread());

  await makeExecute(d)(fake.interaction);
  await fake.click("existing");

  assert.equal(calls.create.length, 0);
  assert.equal(calls.comment.length, 1);
  assert.equal(calls.comment[0].pageId, "fr-1");
  assert.equal(calls.comment[0].details.threadUrl, "https://discord.com/channels/guild-1/thread-1");
  assert.equal(calls.comment[0].details.requesterName, "César Pérez");
  assert.match(fake.lastEdit(), /FR-3/);
  assert.match(fake.lastEdit(), /https:\/\/notion\.so\/fr-1/);
  assert.equal(fake.collector.stoppedWith, "existing");
});

test("Crear solicitud usa lo elegido en los selectores y responde con código y link", async () => {
  const { deps: d, calls } = deps({ findSimilarFeatureRequests: async () => [] });
  const fake = fakeInteraction(thread());

  await makeExecute(d)(fake.interaction);

  const review = fake.calls.editReply.find((m) => m.embeds);
  const ids = review.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
  assert.ok(!ids.includes("feature_existing_user-1"), "sin duplicados no hay Agregar a existente");

  await fake.click("origin", ["Ventas"]);
  await fake.click("area", ["Agenda", "Mobile"]);
  await fake.click("platform", ["Mobile - Web"]);
  await fake.click("create");

  assert.equal(calls.create.length, 1);
  const req = calls.create[0];
  assert.equal(req.origin, "Ventas");
  assert.deepEqual(req.areas, ["Agenda", "Mobile"]);
  assert.equal(req.platform, "Mobile - Web");
  assert.equal(req.requesterId, "notion-cesar");
  assert.equal(req.threadUrl, "https://discord.com/channels/guild-1/thread-1");
  assert.match(fake.lastEdit(), /FR-12/);
  assert.match(fake.lastEdit(), /https:\/\/notion\.so\/new/);
});

test("si falla la búsqueda de duplicados igual se puede crear la solicitud", async () => {
  const { deps: d } = deps({
    findSimilarFeatureRequests: async () => {
      throw new Error("Notion caído");
    },
  });
  const fake = fakeInteraction(thread());

  await makeExecute(d)(fake.interaction);

  assert.ok(fake.calls.editReply.some((m) => m.embeds), "muestra la revisión");
});

test("un error de la IA se muestra claro en Discord", async () => {
  const { deps: d } = deps({
    analyzeFeatureRequest: async () => {
      throw new AIError("No se pudo analizar el thread con la IA: 429.");
    },
  });
  const fake = fakeInteraction(thread());

  await makeExecute(d)(fake.interaction);

  assert.match(fake.lastEdit(), /🤖 No se pudo analizar el thread con la IA/);
});

test("un error de Notion al crear se muestra claro en Discord", async () => {
  const notionError = new APIResponseError({
    code: "object_not_found",
    status: 404,
    message: "Could not find database",
    headers: {},
    rawBodyText: "",
  });
  const { deps: d } = deps({
    createFeatureRequest: async () => {
      throw notionError;
    },
  });
  const fake = fakeInteraction(thread());

  await makeExecute(d)(fake.interaction);
  await fake.click("create");

  assert.match(fake.lastEdit(), /no encuentra la base de Feature Requests/);
  assert.match(fake.lastEdit(), /Comparte esa base con la integración/);
});
