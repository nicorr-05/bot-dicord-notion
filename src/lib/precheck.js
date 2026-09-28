/**
 * The pre-check shown before /ticket and /feature let anyone pick priority,
 * assignee or area: does this thread belong in Notion at all, and is the report
 * complete enough that nobody has to ask again?
 *
 * The rubric comes from the Notion guides (bugs and feature requests). The AI
 * fills it in; everything here is pure: normalizing its answer, deciding how loud
 * the warning is, and rendering the step. The reporter always has the last word.
 * The check only adds friction when there is a reason to, and a check that fails
 * never blocks creating the ticket.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { truncate } from "./feature-requests.js";
import { guideUrl } from "./thread.js";

/** What the thread really is. The first key of each kind is the "belongs here" one. */
export const CLASSIFICATIONS = {
  bug: {
    bug: "Bug de Docguía",
    entorno: "Problema del equipo, navegador o red del usuario",
    externo: "Falla de un servicio externo (SACS, Apple, Google, WhatsApp, banco)",
    duda_de_uso: "Duda de uso o falta de capacitación",
    cuenta: "Gestión de cuenta (contraseña, correo, eliminar cuenta)",
    error_usuario: "Datos mal ingresados por el usuario",
    feature: "Solicitud de funcionalidad: va con /feature",
    incierto: "No hay información suficiente para saber si es bug",
  },
  feature: {
    feature: "Solicitud de funcionalidad",
    bug: "Parece un bug: va con /ticket",
    ya_existe: "Probablemente la función ya existe (duda de uso)",
    soporte: "No es de Docguía: se resuelve desde Soporte Operativo",
    incierto: "No se entiende todavía qué necesita el médico",
  },
};

/** The checklist from each guide. `ok` only when the thread says it explicitly. */
export const CHECKS = {
  bug: [
    { id: "descarto_entorno", label: "Descartó equipo, navegador y red" },
    { id: "reproducible", label: "Se reprodujo o hay evidencia concreta (hora, error exacto)" },
    { id: "esperado_vs_actual", label: "Resultado esperado vs. resultado actual" },
    { id: "contexto", label: "Usuario, plataforma y dispositivo" },
    { id: "impacto", label: "Frecuencia y a quién afecta" },
  ],
  feature: [
    { id: "problema", label: "Problema de fondo, no solo la solución pedida" },
    { id: "quien", label: "Quién lo pide (médico, especialidad)" },
    { id: "hoy", label: "Cómo lo resuelve hoy" },
    { id: "consecuencia", label: "Qué pasa si no lo tenemos" },
    { id: "no_existe", label: "Confirmó que la función no existe hoy" },
  ],
};

const CHECK_STATUSES = ["ok", "parcial", "falta"];
const CHECK_ICON = { ok: "✅", parcial: "🟡", falta: "⬜" };

/** Ready-made answers for the doctor, from section 9 of the bug guide. */
export const CANNED_REPLIES = {
  sacs:
    "Hola, doctor(a). Para validar su registro, el sistema compara sus datos con los del SACS. " +
    "Por favor verifique que su cédula, número MPPS y colegio médico coincidan exactamente con los que " +
    "aparecen en https://sistemas.sacs.gob.ve/consultas/prfsnal_salud. Si hay alguna diferencia, debe " +
    "corregirla ante el SACS. Si coinciden y aún no puede registrarse, envíenos una captura de esa consulta y lo revisamos.",
  app_store:
    "Hola, si no te aparece la app en el App Store, revisa en qué país está configurada tu cuenta de Apple. " +
    "La app no está disponible en la mayoría de países de la Unión Europea. Para cambiarlo: Ajustes > tu nombre > " +
    "Medios y compras > Ver cuenta > País/región, y elige un país donde la app sí esté disponible. Apple puede " +
    "pedirte cancelar suscripciones activas y agregar un método de pago válido para el nuevo país.",
  conexion:
    "Hola, doctor(a). Para descartar un problema de conexión, ¿podría intentar desde otra red (por ejemplo, " +
    "datos móviles) o desde otro navegador como Chrome en modo incógnito? Si el problema continúa, envíenos una " +
    "captura de pantalla completa, la hora en que ocurrió y una descripción de lo que estaba haciendo.",
};

const MAX_QUESTIONS = 3;

function asLine(value) {
  if (Array.isArray(value)) value = value.join(" ");
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Cleans the AI's JSON. Unknown classifications become "incierto", unknown or
 * missing checks become "falta": when in doubt, ask for the information instead
 * of assuming it is there.
 */
export function normalizePrecheck(raw = {}, kind) {
  const classifications = CLASSIFICATIONS[kind];
  const classification = Object.hasOwn(classifications, raw.classification)
    ? raw.classification
    : "incierto";

  const rawChecks = raw.checks && typeof raw.checks === "object" ? raw.checks : {};
  const checks = CHECKS[kind].map(({ id, label }) => {
    const status = String(rawChecks[id] ?? "").toLowerCase();
    return { id, label, status: CHECK_STATUSES.includes(status) ? status : "falta" };
  });

  const questions = (Array.isArray(raw.questions) ? raw.questions : [raw.questions])
    .map(asLine)
    .filter(Boolean)
    .slice(0, MAX_QUESTIONS);

  const cannedReply =
    kind === "bug" && Object.hasOwn(CANNED_REPLIES, raw.cannedReply) ? raw.cannedReply : null;

  return {
    kind,
    classification,
    understood: asLine(raw.understood),
    reason: asLine(raw.reason),
    checks,
    questions,
    cannedReply,
  };
}

/**
 * How loud the step is:
 *   "ready"   belongs here and nothing is missing
 *   "review"  belongs here but the report is incomplete
 *   "warning" probably shouldn't be a ticket / request at all
 */
export function precheckLevel(precheck) {
  if (precheck.classification !== precheck.kind) return "warning";
  return precheck.checks.some((c) => c.status === "falta") ? "review" : "ready";
}

const WORDS = {
  bug: { noun: "bug", item: "el ticket", command: "/ticket" },
  feature: { noun: "feature request", item: "la solicitud", command: "/feature" },
};

const LEVEL = {
  ready: { color: 0x3ba55d, title: (w) => `✅ Parece un ${w.noun} y el reporte está completo` },
  review: { color: 0xe8a33d, title: (w) => `🟡 Parece un ${w.noun}, pero al reporte le falta información` },
  warning: { color: 0xd9534f, title: () => "🛑 Esto quizás no debería ir a Notion" },
};

/** Step 1: what the AI understood, what's missing, and "¿estás seguro?". */
export function buildPrecheckEmbed(precheck, { duplicateCount = 0 } = {}) {
  const words = WORDS[precheck.kind];
  const level = precheckLevel(precheck);

  const intro = [
    precheck.understood && `**Lo que entendí:** ${precheck.understood}`,
    level === "warning" &&
      `**Parece:** ${CLASSIFICATIONS[precheck.kind][precheck.classification]}` +
        (precheck.reason ? `\n${precheck.reason}` : ""),
  ]
    .filter(Boolean)
    .join("\n\n");

  const embed = new EmbedBuilder()
    .setColor(LEVEL[level].color)
    .setTitle(LEVEL[level].title(words))
    .setDescription(truncate(intro || "Revisa el checklist antes de continuar.", 4000))
    .addFields({
      name: "Checklist de la guía",
      value: precheck.checks.map((c) => `${CHECK_ICON[c.status]} ${c.label}`).join("\n"),
    });

  if (precheck.questions.length > 0 && level !== "ready") {
    embed.addFields({
      name: "Antes de crearlo, ¿ya revisaste esto?",
      value: truncate(precheck.questions.map((q) => `• ${q}`).join("\n"), 1024),
    });
  }

  if (precheck.cannedReply) {
    embed.addFields({
      name: "Respuesta sugerida para el médico",
      value: truncate(`>>> ${CANNED_REPLIES[precheck.cannedReply]}`, 1024),
    });
  }

  if (duplicateCount > 0) {
    embed.addFields({
      name: "Posibles duplicados",
      value: `Encontré ${duplicateCount} parecido(s) en Notion. Los verás en el siguiente paso para sumar este caso en vez de crear otro.`,
    });
  }

  embed.addFields({
    name: `¿Estás seguro de crear ${words.item}?`,
    value:
      level === "ready"
        ? "Si sí, en el siguiente paso eliges las opciones."
        : `Si ya lo revisaste, continúa. Si no, completa el thread y vuelve a correr \`${words.command}\`. [Ver la guía](${guideUrl(precheck.kind)})`,
  });

  return embed;
}

/** "Sí" / "No" for step 1. When the check warns, "No" is the prominent one. */
export function buildPrecheckComponents({ prefix, userId, precheck }) {
  const level = precheckLevel(precheck);
  const item = WORDS[precheck.kind].item;

  const yes = new ButtonBuilder()
    .setCustomId(`${prefix}_precheck-yes_${userId}`)
    .setLabel(level === "ready" ? "Sí, continuar" : `Sí, crear ${item} igual`)
    .setStyle(level === "ready" ? ButtonStyle.Success : ButtonStyle.Secondary);

  const no = new ButtonBuilder()
    .setCustomId(`${prefix}_precheck-no_${userId}`)
    .setLabel("No, lo reviso primero")
    .setStyle(level === "ready" ? ButtonStyle.Secondary : ButtonStyle.Primary);

  return [new ActionRowBuilder().addComponents(level === "ready" ? [yes, no] : [no, yes])];
}

/** What stays in the thread after "No": the to-do list, so the work isn't lost. */
export function precheckDeclinedMessage(precheck) {
  const words = WORDS[precheck.kind];
  const missing = precheck.checks.filter((c) => c.status !== "ok").map((c) => `• ${c.label}`);
  const lines = [`📝 **No se creó ${words.item}.**`];

  if (precheckLevel(precheck) === "warning") {
    lines.push(`Parece: ${CLASSIFICATIONS[precheck.kind][precheck.classification]}.`);
  }
  if (precheck.questions.length > 0) {
    lines.push("", "**Para revisar:**", ...precheck.questions.map((q) => `• ${q}`));
  }
  if (missing.length > 0) {
    lines.push("", "**Falta en el thread:**", ...missing);
  }
  lines.push("", `Cuando lo tengas, escríbelo en el thread y vuelve a correr \`${words.command}\`.`, guideUrl(precheck.kind));

  return truncate(lines.join("\n"), 2000);
}

/**
 * Notion blocks recording that the reporter went ahead despite a warning, so
 * whoever triages sees the doubt and what was never confirmed. Nothing when the
 * check passed cleanly: no noise on good tickets.
 */
export function buildPrecheckBlocks(precheck) {
  if (!precheck || precheckLevel(precheck) === "ready") return [];

  const pending = precheck.checks.filter((c) => c.status !== "ok").map((c) => c.label);
  const text =
    (precheckLevel(precheck) === "warning"
      ? `La IA dudó: ${CLASSIFICATIONS[precheck.kind][precheck.classification]}.` +
        (precheck.reason ? ` ${precheck.reason}` : "")
      : "La IA encontró el reporte incompleto.") +
    " Quien reportó confirmó que igual se creara." +
    (pending.length ? `\nSin confirmar en el thread: ${pending.join("; ")}.` : "") +
    (precheck.questions.length ? `\nPreguntas abiertas: ${precheck.questions.join(" ")}` : "");

  return [
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Pre-chequeo de IA" } }] },
    },
    {
      object: "block",
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "⚠️" },
        rich_text: [{ type: "text", text: { content: truncate(text, 2000) } }],
      },
    },
  ];
}
