import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates, verdictLabel } from "../src/lib/duplicates.js";
import { keywords, rankByKeywords } from "../src/lib/similarity.js";
import {
  buildContextComment,
  featureText,
  normalizeFeatureAnalysis,
} from "../src/lib/feature-requests.js";
import {
  addContextComment,
  fetchOpenFeatureRequests,
  findSimilarFeatureRequests,
} from "../src/services/feature-requests.js";
import { buildTicketCaseComment } from "../src/services/notion.js";

const existing = [
  {
    id: "fr-1",
    code: "FR-3",
    title: "Recordatorios automáticos de citas por WhatsApp",
    problem: "Los pacientes faltan a las citas porque nadie les recuerda.",
    stage: "🗣️ En discusión",
  },
  {
    id: "fr-2",
    code: "FR-8",
    title: "Exportar historia clínica en PDF",
    problem: "El médico necesita enviar la historia a otro especialista.",
    stage: "💡 Solicitud",
  },
  {
    id: "fr-3",
    code: "FR-9",
    title: "Firma digital en recetas",
    problem: "Las farmacias rechazan recetas sin firma.",
    stage: "✅ Aprobada",
  },
].map((p) => ({ ...p, text: featureText(p) }));

const candidate = {
  title: "Recordatorio de cita por WhatsApp para reducir inasistencias",
  summary: "La secretaria llama a cada paciente para recordarle la cita y aun así muchos faltan.",
};

test("keywords ignora tildes, plurales y palabras vacías", () => {
  assert.deepEqual([...keywords("Las Citas del médico")], ["cita"]);
  assert.ok(keywords("informes").has("inform") && keywords("informe").has("inform"));
});

test("el filtro por palabras encuentra la misma necesidad y deja fuera lo que no tiene que ver", () => {
  const ranked = rankByKeywords(`${candidate.title} ${candidate.summary}`, existing);
  assert.deepEqual(ranked.map((r) => r.id), ["fr-1"]);
});

test("la IA decide cuáles son lo mismo y su motivo llega a la revisión", async () => {
  let judged;
  const { matches, method } = await findDuplicates({
    candidate,
    items: existing,
    judge: async (args) => {
      judged = args;
      return [
        { id: "fr-1", verdict: "same", reason: "Misma necesidad: recordar citas por WhatsApp." },
        { id: "inventado", verdict: "same", reason: "id que no estaba en la lista" },
      ];
    },
  });

  assert.equal(method, "ai");
  assert.ok(judged.options.some((o) => o.id === "fr-1"), "la IA recibe la lista corta");
  assert.deepEqual(matches.map((m) => m.id), ["fr-1"], "ignora ids que no mandamos");
  assert.equal(matches[0].reason, "Misma necesidad: recordar citas por WhatsApp.");
  assert.equal(matches[0].verdict, "same");
});

test("si la IA dice que ninguno es igual, no se ofrecen duplicados", async () => {
  const { matches } = await findDuplicates({ candidate, items: existing, judge: async () => [] });
  assert.deepEqual(matches, []);
});

test("si la IA falla se usan palabras clave, y si falla el contexto se sigue igual", async () => {
  const { matches, method } = await findDuplicates({
    candidate,
    items: existing,
    enrich: async () => {
      throw new Error("Notion caído");
    },
    judge: async () => {
      throw new Error("OpenAI caído");
    },
  });
  assert.equal(method, "keywords");
  assert.deepEqual(matches.map((m) => m.id), ["fr-1"]);
});

test("sin candidatos en la lista corta no se llama a la IA", async () => {
  const { matches } = await findDuplicates({
    candidate: { title: "Modo oscuro", summary: "Colores oscuros de noche" },
    items: existing,
    judge: async () => assert.fail("no debería llamar a la IA"),
  });
  assert.deepEqual(matches, []);
});

test("la búsqueda excluye Descartada y Lanzada desde la consulta a Notion", async () => {
  let query;
  const client = {
    databases: {
      query: async (q) => {
        query = q;
        return { results: [], has_more: false };
      },
    },
  };
  await fetchOpenFeatureRequests({ client });

  assert.equal(query.database_id, "8d1e8688d520433cbc37725ad9228cd5");
  assert.deepEqual(query.filter, {
    and: [
      { property: "Etapa", select: { does_not_equal: "❌ Descartada" } },
      { property: "Etapa", select: { does_not_equal: "🚀 Lanzada" } },
    ],
  });
});

test("findSimilarFeatureRequests compara título y Problema de las páginas de Notion", async () => {
  const page = (id, title, problem, stage) => ({
    id,
    url: `https://notion.so/${id}`,
    properties: {
      Feature: { title: [{ plain_text: title }] },
      Problema: { rich_text: [{ plain_text: problem }] },
      Etapa: { select: { name: stage } },
      Código: { unique_id: { prefix: "FR", number: 3 } },
    },
  });
  const client = {
    databases: {
      query: async () => ({
        results: [
          page("p1", "Recordatorios de citas", "Recordar la cita por WhatsApp", "💡 Solicitud"),
          page("p2", "Firma digital", "Firmar recetas", "💡 Solicitud"),
        ],
        has_more: false,
      }),
    },
  };

  const matches = await findSimilarFeatureRequests(
    { title: candidate.title, problem: candidate.summary },
    { client, judge: async ({ kind, options }) => {
      assert.equal(kind, "feature");
      return options.map((o) => ({ id: o.id, reason: "igual" }));
    } }
  );

  assert.deepEqual(matches.map((m) => [m.id, m.code]), [["p1", "FR-3"]]);
});

test("Agregar a existente comenta en la página con el contexto y el link al thread", async () => {
  let comment;
  const client = { comments: { create: async (c) => (comment = c) } };
  const analysis = normalizeFeatureAnalysis({
    title: "Recordatorios por WhatsApp",
    problem: "Faltan a las citas.",
    sections: { quienLoPide: "Dra. Pérez, pediatra", quePidioElMedico: "Aviso el día anterior" },
  });

  await addContextComment(
    "fr-1",
    {
      analysis,
      requesterName: "César Pérez",
      threadUrl: "https://discord.com/channels/g/t",
      evidenceSummary: "🖼️ 1 imagen(es)",
    },
    { client }
  );

  assert.deepEqual(comment.parent, { page_id: "fr-1" });
  const text = comment.rich_text.map((r) => r.text.content).join("");
  assert.match(text, /César Pérez/);
  assert.match(text, /Dra\. Pérez, pediatra/);
  assert.match(text, /Faltan a las citas/);
  assert.match(text, /Cómo lo resuelve hoy: No indicado/);
  assert.equal(comment.rich_text.at(-1).text.link.url, "https://discord.com/channels/g/t");
});

test("comentarios largos quedan bajo el límite de Notion", () => {
  const analysis = normalizeFeatureAnalysis({ problem: "x".repeat(5000) });
  const rich = buildContextComment({ analysis, requesterName: "a", threadUrl: "https://d/t" });
  assert.ok(rich.every((r) => r.text.content.length <= 2000));

  const bug = buildTicketCaseComment({
    analysis: { description: "y".repeat(5000), stepsToReproduce: "1. abrir" },
    reporterName: "b",
    threadUrl: "https://d/t",
  });
  assert.ok(bug.every((r) => r.text.content.length <= 2000));
  assert.equal(bug.at(-1).text.link.url, "https://d/t");
});

test("lo igual va antes que lo relacionado y cada uno lleva su etiqueta", async () => {
  const items = [
    { id: "a", title: "Recordatorios de cita por SMS", text: "recordatorio cita sms inasistencia" },
    { id: "b", title: "Recordatorios de cita por WhatsApp", text: "recordatorio cita whatsapp inasistencia" },
  ];
  const { matches } = await findDuplicates({
    candidate,
    items,
    judge: async () => [
      { id: "a", verdict: "related", reason: "Otro canal, mismo objetivo." },
      { id: "b", verdict: "same", reason: "Es lo mismo." },
    ],
  });
  assert.deepEqual(matches.map((m) => [m.id, m.verdict]), [["b", "same"], ["a", "related"]]);
  assert.equal(verdictLabel("same"), "🟰 Parece lo mismo");
  assert.equal(verdictLabel("related"), "≈ Relacionado");
  assert.equal(verdictLabel(undefined), "🔎 Parecido por palabras");
});
