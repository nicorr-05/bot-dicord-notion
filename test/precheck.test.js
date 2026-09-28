import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANNED_REPLIES,
  buildPrecheckBlocks,
  buildPrecheckComponents,
  buildPrecheckEmbed,
  normalizePrecheck,
  precheckDeclinedMessage,
  precheckLevel,
} from "../src/lib/precheck.js";
import { makeExecute as makeTicket } from "../src/commands/ticket.js";
import { makeExecute as makeFeature } from "../src/commands/feature.js";
import { normalizeFeatureAnalysis } from "../src/lib/feature-requests.js";
import { BUG_GUIDE_URL, FEATURE_GUIDE_URL } from "../src/lib/thread.js";
import { WELL_DESCRIBED, fakeInteraction, thread } from "./helpers.js";

const allOk = {
  descarto_entorno: "ok",
  reproducible: "ok",
  esperado_vs_actual: "ok",
  contexto: "ok",
  impacto: "ok",
};

const dictation = normalizePrecheck(
  {
    understood: "Al doctor no le funciona el dictado por voz en la web.",
    classification: "entorno",
    reason: "Solo le pasa a un médico y nadie probó otro navegador ni revisó el micrófono.",
    checks: { esperado_vs_actual: "parcial" },
    questions: [
      "¿Probaste el dictado en otro navegador o computadora?",
      "¿El navegador tiene permiso para usar el micrófono?",
    ],
    cannedReply: "conexion",
  },
  "bug"
);

// ─── Pure pieces ──────────────────────────────────────────────────────────────

test("normaliza: clasificación desconocida → incierto, checks ausentes → falta", () => {
  const p = normalizePrecheck({ classification: "otra cosa", checks: { contexto: "ok", impacto: "sí" } }, "bug");
  assert.equal(p.classification, "incierto");
  assert.equal(p.checks.find((c) => c.id === "contexto").status, "ok");
  assert.equal(p.checks.find((c) => c.id === "impacto").status, "falta");
  assert.equal(p.checks.find((c) => c.id === "reproducible").status, "falta");
});

test("normaliza: máximo 3 preguntas y respuesta sugerida solo si existe y es bug", () => {
  const p = normalizePrecheck({ questions: ["a", "b", "", "c", "d"], cannedReply: "inventada" }, "bug");
  assert.deepEqual(p.questions, ["a", "b", "c"]);
  assert.equal(p.cannedReply, null);
  assert.equal(normalizePrecheck({ cannedReply: "sacs" }, "feature").cannedReply, null);
  assert.equal(normalizePrecheck({ cannedReply: "sacs" }, "bug").cannedReply, "sacs");
});

test("nivel: listo, revisar o advertencia", () => {
  assert.equal(precheckLevel(normalizePrecheck({ classification: "bug", checks: allOk }, "bug")), "ready");
  assert.equal(
    precheckLevel(normalizePrecheck({ classification: "bug", checks: { ...allOk, impacto: "falta" } }, "bug")),
    "review"
  );
  assert.equal(precheckLevel(dictation), "warning");
  assert.equal(precheckLevel(normalizePrecheck({ classification: "bug" }, "feature")), "warning");
});

test("el embed de advertencia muestra la duda, las preguntas, la respuesta sugerida y ¿estás seguro?", () => {
  const embed = buildPrecheckEmbed(dictation, { duplicateCount: 2 }).toJSON();
  assert.match(embed.title, /quizás no debería ir a Notion/);
  assert.match(embed.description, /equipo, navegador o red/);
  const names = embed.fields.map((f) => f.name);
  assert.ok(names.includes("Antes de crearlo, ¿ya revisaste esto?"));
  assert.ok(names.includes("Respuesta sugerida para el médico"));
  assert.ok(names.includes("Posibles duplicados"));
  assert.equal(names.at(-1), "¿Estás seguro de crear el ticket?");
  assert.ok(embed.fields.at(-1).value.includes(BUG_GUIDE_URL));
  assert.ok(embed.fields.find((f) => f.name.startsWith("Respuesta")).value.includes(CANNED_REPLIES.conexion.slice(0, 40)));
});

test("con advertencia, 'No' va primero y resaltado; si está listo, 'Sí' va primero", () => {
  const labels = (p) =>
    buildPrecheckComponents({ prefix: "ticket", userId: "u", precheck: p })[0]
      .toJSON()
      .components.map((c) => c.custom_id);
  assert.deepEqual(labels(dictation), ["ticket_precheck-no_u", "ticket_precheck-yes_u"]);
  const ready = normalizePrecheck({ classification: "bug", checks: allOk }, "bug");
  assert.deepEqual(labels(ready), ["ticket_precheck-yes_u", "ticket_precheck-no_u"]);
});

test("el mensaje de 'No' deja la lista de qué revisar y la guía correcta", () => {
  const text = precheckDeclinedMessage(dictation);
  assert.match(text, /No se creó el ticket/);
  assert.match(text, /permiso para usar el micrófono/);
  assert.match(text, /Descartó equipo, navegador y red/);
  assert.ok(text.includes(BUG_GUIDE_URL));
  const feature = precheckDeclinedMessage(normalizePrecheck({ classification: "ya_existe" }, "feature"));
  assert.ok(feature.includes(FEATURE_GUIDE_URL));
});

test("en Notion solo queda nota cuando se siguió pese a una advertencia", () => {
  assert.deepEqual(buildPrecheckBlocks(null), []);
  assert.deepEqual(buildPrecheckBlocks(normalizePrecheck({ classification: "bug", checks: allOk }, "bug")), []);
  const blocks = buildPrecheckBlocks(dictation);
  assert.equal(blocks[1].type, "callout");
  assert.match(blocks[1].callout.rich_text[0].text.content, /La IA dudó/);
  assert.match(blocks[1].callout.rich_text[0].text.content, /confirmó que igual se creara/);
});

// ─── /ticket flow ─────────────────────────────────────────────────────────────

function ticketDeps(overrides = {}) {
  const calls = { create: [] };
  return {
    calls,
    deps: {
      fetchAllMessages: async () => WELL_DESCRIBED,
      analyzeThread: async () => ({
        title: "El dictado no funciona",
        description: "No transcribe.",
        priority: "Medium",
        stepsToReproduce: "1. Abrir consulta",
      }),
      precheckReport: async () => dictation,
      fetchTicketOptions: async () => ({
        priorityOptions: ["High", "Medium", "Low"],
        sprintOptions: [],
        sprintType: "relation",
        userOptions: [{ id: "n-nico", name: "Nicolás Restrepo" }],
        defaultAssigneeId: "n-nico",
      }),
      findSimilarTickets: async () => [],
      resolveReporterId: () => "n-nico",
      createTicket: async (t) => (calls.create.push(t), { id: "t1", url: "https://notion.so/t1" }),
      addTicketComment: async () => {},
      ...overrides,
    },
  };
}

const bugThread = () => thread({ parentId: "bug-channel", parentName: "bug-reports" });

test("/ticket muestra primero el pre-chequeo, sin selectores de prioridad ni assignee", async () => {
  const { deps } = ticketDeps();
  const fake = fakeInteraction(bugThread(), { prefix: "ticket" });

  await makeTicket(deps)(fake.interaction);

  const step1 = fake.calls.editReply.at(-1);
  assert.match(step1.embeds[0].toJSON().title, /quizás no debería ir a Notion/);
  const ids = step1.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.deepEqual(ids, ["ticket_precheck-no_user-1", "ticket_precheck-yes_user-1"]);
});

test("/ticket: 'No, lo reviso primero' no crea nada y deja qué revisar", async () => {
  const { deps, calls } = ticketDeps();
  const fake = fakeInteraction(bugThread(), { prefix: "ticket" });

  await makeTicket(deps)(fake.interaction);
  await fake.click("precheck-no");

  assert.equal(calls.create.length, 0);
  assert.equal(fake.collector.stoppedWith, "declined");
  assert.match(fake.lastEdit(), /No se creó el ticket/);
  assert.match(fake.lastEdit(), /micrófono/);
});

test("/ticket: 'Sí' pasa a los selectores y el ticket guarda la nota del pre-chequeo", async () => {
  const { deps, calls } = ticketDeps();
  const fake = fakeInteraction(bugThread(), { prefix: "ticket" });

  await makeTicket(deps)(fake.interaction);
  await fake.click("precheck-yes");

  const step2 = fake.calls.editReply.at(-1);
  const ids = step2.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.ok(ids.includes("ticket_assignee_user-1"));
  assert.ok(ids.includes("ticket_create_user-1"));

  await fake.click("create");
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].precheckBlocks[1].type, "callout");
  assert.equal(calls.create[0].assigneeId, "n-nico");
});

test("/ticket: si el pre-chequeo falla, va directo a los selectores", async () => {
  const { deps } = ticketDeps({
    precheckReport: async () => {
      throw new Error("429");
    },
  });
  const fake = fakeInteraction(bugThread(), { prefix: "ticket" });

  await makeTicket(deps)(fake.interaction);

  const ids = fake.calls.editReply
    .at(-1)
    .components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.ok(ids.includes("ticket_create_user-1"));
});

// ─── /feature flow ────────────────────────────────────────────────────────────

test("/feature: 'Sí' lleva a la revisión y 'Crear' guarda la nota; sin 'Sí' no hay selectores", async () => {
  const created = [];
  const precheck = normalizePrecheck(
    { classification: "ya_existe", reason: "Docguía ya envía recordatorios por correo." },
    "feature"
  );
  const fake = fakeInteraction(thread());

  await makeFeature({
    fetchAllMessages: async () => WELL_DESCRIBED,
    analyzeFeatureRequest: async () => normalizeFeatureAnalysis({ title: "Recordatorios", problem: "Faltan" }),
    precheckReport: async () => precheck,
    listWorkspaceUsers: async () => [{ id: "n-cesar", name: "César Pérez" }],
    resolveReporterId: () => "n-cesar",
    findSimilarFeatureRequests: async () => [],
    createFeatureRequest: async (r) => (created.push(r), { id: "f", url: "https://notion.so/f", code: "FR-9" }),
    addContextComment: async () => {},
  })(fake.interaction);

  const step1 = fake.calls.editReply.at(-1);
  assert.match(step1.embeds[0].toJSON().description, /ya existe/);
  const step1Ids = step1.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.ok(!step1Ids.includes("feature_origin_user-1"));

  await fake.click("precheck-yes");
  await fake.click("create");

  assert.equal(created.length, 1);
  assert.equal(created[0].precheckBlocks[1].type, "callout");
  assert.match(fake.lastEdit(), /FR-9/);
});
