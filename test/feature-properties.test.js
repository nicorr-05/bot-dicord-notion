import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_PROP,
  NOT_STATED,
  buildFeatureBody,
  buildFeatureProperties,
  formatCode,
  normalizeFeatureAnalysis,
} from "../src/lib/feature-requests.js";
import { createFeatureRequest } from "../src/services/feature-requests.js";

const analysis = normalizeFeatureAnalysis({
  title: "Recordatorios de cita por WhatsApp para reducir inasistencias",
  problem: "Los pacientes olvidan sus citas y la secretaria pierde horas llamando.",
  areas: ["Agenda"],
  platform: "Web",
  sections: { quienLoPide: "Pediatra", quePidioElMedico: "Recordatorio por WhatsApp" },
});

test("las propiedades usan los nombres exactos de Notion, con tildes y emojis", () => {
  const props = buildFeatureProperties({
    ...analysis,
    origin: "Customer success",
    requesterId: "notion-user-1",
  });

  assert.deepEqual(Object.keys(props).sort(), [
    "Etapa",
    "Feature",
    "Origen",
    "Plataforma",
    "Problema",
    "Solicitado por",
    "Área",
  ]);
  assert.equal(props.Feature.title[0].text.content, analysis.title);
  assert.equal(props.Problema.rich_text[0].text.content, analysis.problem);
  assert.deepEqual(props.Etapa, { select: { name: "💡 Solicitud" } });
  assert.deepEqual(props.Origen, { select: { name: "Customer success" } });
  assert.deepEqual(props["Área"], { multi_select: [{ name: "Agenda" }] });
  assert.deepEqual(props.Plataforma, { select: { name: "Web" } });
  assert.deepEqual(props["Solicitado por"], {
    people: [{ object: "user", id: "notion-user-1" }],
  });
});

test("nunca llena los campos que decide producto", () => {
  const props = buildFeatureProperties({ ...analysis, origin: null, requesterId: "u" });
  for (const name of [
    "Prioridad",
    "Impacto",
    "Esfuerzo",
    "Owner producto",
    "Owner UX",
    "Target",
    "Diseño",
    "Spec lista",
    "Diseño aprobado",
  ]) {
    assert.equal(props[name], undefined, `${name} debe quedar vacío`);
  }
});

test("Origen por defecto es Médicos / clientes; sin plataforma ni usuario se omiten", () => {
  const props = buildFeatureProperties({ ...analysis, origin: null, platform: null, requesterId: null });
  assert.deepEqual(props.Origen, { select: { name: "Médicos / clientes" } });
  assert.equal(props.Plataforma, undefined);
  assert.equal(props["Solicitado por"], undefined);
});

test("la respuesta de la IA se ajusta a opciones reales y no deja campos vacíos", () => {
  const n = normalizeFeatureAnalysis({
    title: ["Exportar historia clínica"],
    problem: "",
    areas: ["historia clinica", "Telemedicina", "AGENDA", "Agenda"],
    platform: "mobile - web",
    sections: { cuantosLoHanPedido: null, quienLoPide: ["Odontólogo", "Clínica"] },
  });

  assert.equal(n.title, "Exportar historia clínica");
  assert.equal(n.problem, NOT_STATED);
  assert.deepEqual(n.areas, ["Historia clínica", "Agenda"], "descarta áreas inventadas y repetidas");
  assert.equal(n.platform, "Mobile - Web");
  assert.equal(n.sections.cuantosLoHanPedido, NOT_STATED);
  assert.equal(n.sections.comoLoResuelveHoy, NOT_STATED);
  assert.equal(n.sections.quienLoPide, "Odontólogo\nClínica");
  assert.equal(normalizeFeatureAnalysis({ platform: "Desktop" }).platform, null);
});

test("el cuerpo tiene las secciones en orden, la evidencia y el link al thread", () => {
  const evidence = [{ object: "block", type: "image", image: { type: "file_upload", file_upload: { id: "f1" } } }];
  const blocks = buildFeatureBody({
    sections: analysis.sections,
    requesterName: "cesar.docguia",
    requesterDiscordId: "42",
    threadUrl: "https://discord.com/channels/g/t",
    evidenceBlocks: evidence,
  });

  const headings = blocks
    .filter((b) => b.type === "heading_2")
    .map((b) => b.heading_2.rich_text[0].text.content);
  assert.deepEqual(headings, [
    "Problema",
    "Quién lo pide",
    "Cuántos lo han pedido",
    "Cómo lo resuelve hoy",
    "Qué pidió el médico",
    "Qué pasa si no lo tenemos",
    "Evidencia",
    "Origen",
  ]);

  const evidenceHeading = blocks.findIndex((b) => b.heading_2?.rich_text[0].text.content === "Evidencia");
  assert.equal(blocks[evidenceHeading + 2], evidence[0], "las imágenes van bajo Evidencia");

  const footer = blocks.at(-1).paragraph.rich_text;
  assert.match(footer[0].text.content, /Discord thread: $/);
  assert.equal(footer[1].text.link.url, "https://discord.com/channels/g/t");
});

test("el código de la solicitud se lee del unique_id", () => {
  assert.equal(formatCode({ prefix: "FR", number: 12 }), "FR-12");
  assert.equal(formatCode({ prefix: null, number: 7 }), "#7");
  assert.equal(formatCode(undefined), null);
});

test("createFeatureRequest crea la página en la base de features y devuelve el código", async () => {
  let created;
  const client = {
    pages: {
      create: async (req) => {
        created = req;
        return {
          id: "page-1",
          url: "https://notion.so/page-1",
          properties: { [FEATURE_PROP.CODE]: { unique_id: { prefix: "FR", number: 31 } } },
        };
      },
    },
    blocks: { children: { append: async () => assert.fail("no hace falta append") } },
  };

  const page = await createFeatureRequest(
    {
      analysis,
      origin: "Ventas",
      areas: ["Agenda"],
      platform: "Web",
      requesterId: "u1",
      requesterName: "cesar.docguia",
      threadUrl: "https://discord.com/channels/g/t",
      attachments: [{ url: "https://cdn/x.png", name: "x.png", contentType: "image/png" }],
    },
    { client, uploadEvidence: async (atts) => atts.map(() => ({ type: "image" })) }
  );

  assert.deepEqual(created.parent, { database_id: "8d1e8688d520433cbc37725ad9228cd5" });
  assert.deepEqual(created.properties.Origen, { select: { name: "Ventas" } });
  assert.ok(created.children.some((b) => b.type === "image"));
  assert.deepEqual(page, { id: "page-1", url: "https://notion.so/page-1", code: "FR-31" });
});
