import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditIdentities,
  formatAudit,
  isClean,
  linkRow,
  nameKey,
} from "../src/lib/identity-audit.js";
import { linkByDiscordId, registerRuntimeLinks } from "../src/config/user-links.js";

const links = [
  { notionId: "n-cesar", notionName: "César Pérez", discordId: "d-cesar", discordUsername: "cesar.docguia" },
  { notionId: "n-gone", notionName: "gley ortiz", discordId: "d-gone", discordUsername: "gleydery" },
];

const notionUsers = [
  { id: "n-cesar", name: "César Pérez" },
  { id: "n-sadiel", name: "sadiel matus" },
  { id: "n-yender", name: "Yender Alvarez" },
  { id: "n-ana", name: "Ana" },
];

const discordMembers = [
  { id: "d-cesar", username: "cesar.docguia", globalName: "Cesar Perez" },
  { id: "d-sadiel", username: "sadiel.matus", globalName: "Sadiel.matus" },
  { id: "d-yender", username: "yenderdevdocguia", globalName: "Yender Alvarez" },
  { id: "d-pepe", username: "pepe_99", globalName: "Pepe" },
  { id: "d-bot", username: "Sentry", bot: true },
];

test("nameKey iguala tildes, puntos, guiones y sufijos entre paréntesis", () => {
  assert.equal(nameKey("Sadiel.matus"), nameKey("sadiel matus"));
  assert.equal(nameKey("Sádiel_Matus"), "sadiel matus");
  assert.equal(nameKey("Carlos Parra (your Favorite CEO)"), "carlos parra");
});

test("vincula solo cuando el nombre coincide sin ambigüedad en ambos lados", () => {
  const audit = auditIdentities({ notionUsers, discordMembers, links });

  assert.deepEqual(
    audit.autoLinks.map((l) => [l.notionName, l.discordUsername]),
    [
      ["sadiel matus", "sadiel.matus"],
      ["Yender Alvarez", "yenderdevdocguia"],
    ]
  );
  assert.deepEqual(audit.unmatchedNotion.map((u) => u.name), ["Ana"]);
  assert.deepEqual(audit.unmatchedDiscord.map((m) => m.username), ["pepe_99"], "ignora bots");
  assert.deepEqual(audit.staleLinks.map((l) => l.notionName), ["gley ortiz"]);
});

test("dos personas con el mismo nombre no se vinculan solas", () => {
  const audit = auditIdentities({
    notionUsers: [{ id: "n1", name: "Carlos" }],
    discordMembers: [
      { id: "d1", username: "carlos" },
      { id: "d2", username: "otro", globalName: "Carlos" },
    ],
    links: [],
  });
  assert.equal(audit.autoLinks.length, 0);
  assert.equal(audit.unmatchedNotion.length, 1);
  assert.equal(audit.unmatchedDiscord.length, 2);
});

test("no marca como obsoleta una fila cuya persona sigue en uno de los dos lados", () => {
  const audit = auditIdentities({
    notionUsers: [],
    discordMembers: [{ id: "d-miguel", username: "dr.miguelluzardo" }],
    links: [{ notionId: "n-miguel", notionName: "miguel", discordId: "d-miguel", discordUsername: "dr.miguelluzardo" }],
  });
  assert.equal(audit.staleLinks.length, 0);
  assert.equal(isClean(audit), true);
});

test("el reporte trae las filas listas para pegar en user-links.js", () => {
  const audit = auditIdentities({ notionUsers, discordMembers, links });
  const report = formatAudit(audit);

  assert.ok(report.includes(linkRow(audit.autoLinks[0])));
  assert.match(report, /Ana — `n-ana`/);
  assert.match(report, /Pepe \(@pepe_99\)/);
  assert.match(report, /gley ortiz/);
  assert.equal(
    formatAudit({ autoLinks: [], unmatchedNotion: [], unmatchedDiscord: [], staleLinks: [] }),
    "✅ Todas las personas de Notion y Discord están vinculadas."
  );
});

test("los vínculos automáticos se usan en las búsquedas pero no pisan la tabla", () => {
  registerRuntimeLinks([
    { notionId: "n-nuevo", notionName: "Nuevo", discordId: "d-nuevo", discordUsername: "nuevo" },
    // Discord id que ya está en la tabla (Nicolas): se ignora.
    { notionId: "n-impostor", notionName: "X", discordId: "644160902983319593", discordUsername: "x" },
  ]);
  assert.equal(linkByDiscordId("d-nuevo")?.notionId, "n-nuevo");
  assert.equal(linkByDiscordId("644160902983319593")?.notionName, "Nicolas Restrepo");
});
