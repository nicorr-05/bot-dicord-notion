import OpenAI from "openai";
import { AIError } from "../lib/errors.js";
import {
  AREA_OPTIONS,
  NOT_STATED,
  PLATFORM_OPTIONS,
  normalizeFeatureAnalysis,
} from "../lib/feature-requests.js";
import { CHECKS, CLASSIFICATIONS, normalizePrecheck } from "../lib/precheck.js";

const DEFAULT_MODEL = "gpt-6-luna";

/** Read on each call so tests and scripts can switch models through the env. */
function model(purpose) {
  const specific = purpose === "precheck" ? process.env.OPENAI_PRECHECK_MODEL : null;
  return specific || process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

/**
 * gpt-4o / gpt-4.1 take a temperature. Reasoning models (gpt-5 and later) reject
 * anything but the default and get the lowest reasoning effort instead: these are
 * short extraction tasks where waiting for a long chain of thought isn't worth it.
 * The original gpt-5 family's lowest effort is "minimal"; later ones use "none".
 */
export function samplingParams(modelName, temperature) {
  if (/^gpt-4/.test(modelName)) return { temperature };
  const effort =
    process.env.OPENAI_REASONING_EFFORT ||
    (/^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(modelName) ? "minimal" : "none");
  return { reasoning_effort: effort };
}

/** Created on first use, so importing this module doesn't require an API key. */
let openai;
function client() {
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/** Em dashes read as machine-written; every AI text is shown to people, so swap them for commas. */
function withoutEmDashes(value) {
  if (typeof value === "string") return value.replace(/\s*—\s*/g, ", ");
  if (Array.isArray(value)) return value.map(withoutEmDashes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutEmDashes(v)]));
  }
  return value;
}

/**
 * Sends a prompt that must be answered with a JSON object and parses it. Failures
 * come back as AIError with a message that can be shown in Discord as-is.
 */
async function completeJson(prompt, { temperature = 0.2, purpose } = {}) {
  const name = model(purpose);
  let response;
  try {
    response = await client().chat.completions.create({
      model: name,
      messages: [{ role: "user", content: prompt }],
      ...samplingParams(name, temperature),
      response_format: { type: "json_object" },
    });
  } catch (error) {
    const reason =
      error?.status === 429
        ? "la IA está saturada o sin cuota (429)"
        : error?.status === 401
          ? "la clave de OpenAI no es válida (401)"
          : error.message;
    throw new AIError(`No se pudo analizar el thread con la IA: ${reason}. Intenta de nuevo en un momento.`, { cause: error });
  }

  try {
    return withoutEmDashes(JSON.parse(response.choices[0].message.content));
  } catch (error) {
    throw new AIError("La IA devolvió una respuesta ilegible. Intenta de nuevo.", { cause: error });
  }
}

/** "[author]: message" lines, with the files each message carried. */
function formatConversation(messages) {
  return messages
    .map((m) => {
      const files = (m.attachments ?? []).map((a) => a.name).join(", ");
      return `[${m.author}]: ${m.content}` + (files ? ` [adjuntos: ${files}]` : "");
    })
    .join("\n");
}

/**
 * Analyzes a Discord thread and extracts structured bug ticket data.
 * @param {string} threadTitle - The name of the Discord thread.
 * @param {Array<{author: string, content: string}>} messages - Thread messages.
 * @returns {Promise<{title: string, description: string, priority: string, stepsToReproduce: string}>}
 */
export async function analyzeThread(threadTitle, messages) {
  const conversation = messages
    .map((m) => `[${m.author}]: ${m.content}`)
    .join("\n");

  const prompt = `
You are a QA engineer. Analyze the following Discord bug-report thread and extract structured information to create a Notion ticket.

Thread title: "${threadTitle}"

Messages:
${conversation}

Return a JSON object with exactly these fields:
- "title": A concise, clear bug title (max 80 chars). In Spanish.
- "description": A clear summary of the bug, what happens vs what should happen (2-4 sentences). In Spanish.
- "priority": One of exactly: "Urgent", "High", "Medium", "Low", based on the severity discussed.
- "stepsToReproduce": A numbered list of steps to reproduce the bug, extracted from the discussion. If not clear, write "Sin especificar". In Spanish.

Respond ONLY with valid JSON, no markdown, no extra text.
`;

  const result = await completeJson(prompt, { temperature: 0.2 });

  // Sanitize: ensure all fields are strings (OpenAI sometimes returns arrays)
  if (Array.isArray(result.stepsToReproduce)) {
    result.stepsToReproduce = result.stepsToReproduce
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");
  }
  if (Array.isArray(result.description)) {
    result.description = result.description.join(" ");
  }
  if (Array.isArray(result.title)) {
    result.title = result.title[0];
  }

  return result;
}

const PRECHECK_RUBRIC = {
  bug: `
Un bug es cuando Docguía no hace lo que debería, y la causa está en nuestro código,
servidores o configuración. Deben cumplirse las tres condiciones:
1. Es una falla de Docguía, no del dispositivo, la red, la cuenta del usuario o un
   sistema externo (SACS, Apple, Google, WhatsApp, banco).
2. Hay un comportamiento esperado claro que no se cumple.
3. Se puede reproducir o hay evidencia concreta (captura del error, hora exacta, usuario).

NO es bug (clasificación entre paréntesis):
- Registro rechazado porque "los datos no coinciden" (cédula, MPPS, colegio): los datos
  del SACS no coinciden. Solo es bug si se verificó que coinciden exactamente. (externo)
- La app no aparece en el App Store: cuenta de Apple en un país sin la app. (externo)
- El link no abre desde Instagram: navegador interno o tienda en otro país. (entorno)
- Computadora lenta, se congela, no imprime, micrófono o cámara que no responden en un
  solo equipo: problema del equipo, drivers o permisos del navegador. (entorno)
- "No carga" con mala conexión, o funciona en otra red. (entorno)
- El usuario no sabe cómo hacer algo. (duda_de_uso)
- "Sería bueno que la app hiciera X". (feature)
- Olvidó contraseña, cambió de correo, quiere eliminar la cuenta. (cuenta)
- WhatsApp, Apple, Google, el banco o el SACS caídos. (externo)
- El usuario ingresó datos incorrectos. (error_usuario)

Señales de que probablemente NO es bug: solo le pasa a un usuario; funciona en otro
dispositivo, navegador o red; el mensaje de error viene de otro sistema; el sistema
hace lo que fue diseñado pero al usuario no le gusta.

Señales de que SÍ es bug aunque falten datos: error de nuestro servidor ("Error 500",
"Error inesperado"), se reprodujo en la cuenta de prueba, afecta a varios médicos,
datos clínicos o de pacientes equivocados, pérdida de información.`,

  feature: `
Un feature request es algo que Docguía no hace hoy, o un cambio en algo que ya
funciona como fue diseñado. Prueba rápida: ¿Docguía fue diseñado para hacer esto y no
lo hace? Sí → es bug (bug). Nunca lo ha hecho → feature. No es problema de Docguía
(equipo, red, SACS, App Store) → soporte.

- "Al guardar el recipe sale un error" → bug.
- "Quiero que el recipe salga con mi logo" → feature.
- "No me llegan los recordatorios" → bug si la función existe y está activada.
- "No encuentro dónde exportar mis pacientes" → ya_existe si la función existe; si no, feature.
- "El botón está muy escondido" → feature (mejora de UX).
La solicitud debe describir el PROBLEMA del médico, no solo la solución que pidió.`,
};

const PRECHECK_CHECK_HELP = {
  bug: `
  - "descarto_entorno": se probó en otro navegador, modo incógnito, otra red u otro dispositivo.
  - "reproducible": se reprodujo (idealmente en la cuenta de prueba) o hay evidencia concreta: hora exacta, error textual.
  - "esperado_vs_actual": queda claro qué debería pasar y qué pasa en realidad.
  - "contexto": se sabe qué usuario/cuenta, plataforma (Web/iOS/Android) y dispositivo o navegador.
  - "impacto": frecuencia (siempre/a veces/una vez) y a cuántos usuarios afecta.`,
  feature: `
  - "problema": explica el dolor del médico y en qué momento de su trabajo, no solo "quiere X".
  - "quien": quién lo pide (nombre, especialidad o tipo de cliente).
  - "hoy": cómo lo resuelve hoy (papel, Excel, otra app, no lo hace).
  - "consecuencia": qué pasa si no lo tenemos.
  - "no_existe": el thread dice que se verificó que Docguía no lo hace ya.`,
};

/**
 * Checks a thread against the reporting guide before anything is created: is it
 * really a bug (or a feature request), what's missing, and what to ask first.
 *
 * LLMs lean heavily towards calling any report valid, so the prompt spells out the
 * guide's "not a bug" cases, asks for each check before the verdict, and only
 * counts what the thread says explicitly.
 *
 * @param {"bug"|"feature"} kind
 * @returns {Promise<ReturnType<typeof normalizePrecheck>>}
 */
export async function precheckReport(kind, threadTitle, messages) {
  const classifications = Object.keys(CLASSIFICATIONS[kind]);
  const checkIds = CHECKS[kind].map((c) => c.id);
  const expected = kind === "bug" ? "un bug" : "un feature request";

  const prompt = `
Eres el líder de Soporte Operativo de DocGuía, un software clínico que usan médicos y
odontólogos (web y apps iOS/Android: agenda, historia clínica, recipes, informes,
dictado por voz, pagos, odontograma). Alguien del equipo quiere crear ${expected} en
Notion a partir de este thread de Discord. Tu trabajo es evitar tickets que no deberían
existir y guiar a quien reporta sobre qué revisar antes.

Criterio de la guía del equipo:
${PRECHECK_RUBRIC[kind]}

Título del thread: "${threadTitle}"

Mensajes:
${formatConversation(messages)}

Devuelve un objeto JSON con estos campos, en este orden:
- "understood": una frase en español con lo que entendiste que pasa. Sin nombres de pacientes.
- "checks": objeto con cada uno de ${JSON.stringify(checkIds)} y valor "ok", "parcial" o "falta":${PRECHECK_CHECK_HELP[kind]}
  "ok" SOLO si el thread lo dice explícitamente. Si no se menciona, es "falta". No supongas.
- "classification": una de ${JSON.stringify(classifications)}: lo que MÁS PROBABLEMENTE
  es, según lo que describe el thread. Lo que falta en el reporte ya queda en "checks";
  no lo uses para decidir la clasificación. Si el caso encaja en uno de los ejemplos
  de la guía, usa esa clasificación aunque el reporte esté incompleto.
  Usa "incierto" SOLO si ni siquiera se entiende qué le pasa al usuario o qué pide.
- "reason": 1 o 2 frases con el porqué de la clasificación, citando lo que dice (o no dice) el thread.
- "questions": de 1 a 3 preguntas cortas en español que quien reporta debería poder
  responder antes de crear el ticket, ESPECÍFICAS de este caso, empezando por lo que más
  descartaría una causa ajena a Docguía. Ejemplo para "al doctor no le funciona el
  dictado": "¿Probaste el dictado en otro navegador o computadora?", "¿El navegador tiene
  permiso para usar el micrófono?", "¿El micrófono funciona en otra app, como una nota de voz?".
  NUNCA preguntes algo que el thread ya responde. Si el reporte está completo, array vacío.
${kind === "bug" ? `- "cannedReply": "sacs" si es un problema de datos del SACS al registrarse, "app_store" si la
  app no aparece en la tienda, "conexion" si parece un problema de red o equipo, o null.` : ""}
Todo en español. Responde SOLO con JSON válido, sin markdown.
`;

  const raw = await completeJson(prompt, { temperature: 0, purpose: "precheck" });
  return normalizePrecheck(raw, kind);
}

/**
 * Writes the release note for a finished ticket.
 *
 * The audience is the DocGuía community, not the team that fixed it: no ticket
 * jargon, no internal names, no "se corrigió el endpoint". It also must not invent
 * anything — if the ticket doesn't say it, it doesn't go in the note, because a
 * release message claiming a fix that didn't happen is worse than a vague one.
 *
 * The privacy rule is not optional: bug reports routinely name the doctor, clinic
 * or patient who hit the problem, and #releases is a public channel. Anything that
 * identifies a person has to be dropped on the way out.
 *
 * @returns {Promise<{headline: string, summary: string, details: string[]}>}
 */
export async function summarizeRelease({ title, taskType, description, pageText }) {
  const prompt = `
Eres el encargado de comunicar releases de DocGuía, un software clínico que usan
médicos y odontólogos. Escribe el anuncio de un ticket que acaba de quedar listo.

Tipo de ticket: ${taskType ?? "sin especificar"}
Título interno: "${title}"

Descripción del ticket:
${description || "(vacía)"}

Contenido de la página:
${pageText || "(vacío)"}

Devuelve un objeto JSON con exactamente estos campos:
- "headline": el cambio en lenguaje de usuario, máximo 80 caracteres, sin emojis,
  sin punto final. Si es un bug, describe qué quedó funcionando, no qué fallaba.
- "summary": 2 a 3 frases explicando qué cambió y qué significa en el día a día de
  quien usa DocGuía. Tono cercano y directo, sin tecnicismos, sin nombres de
  archivos, endpoints ni componentes.
- "details": array de 0 a 3 strings, cada uno un detalle concreto y verificable del
  ticket (máximo 100 caracteres, sin viñetas ni emojis). Array vacío si el ticket no
  da para más.

Reglas:
- Todo en español.
- NUNCA menciones personas, consultorios, clínicas ni pacientes, aunque aparezcan en
  el ticket. Nada de "el doctor X" o "la secretaria de Y": este anuncio es público.
  Habla siempre en general ("algunos usuarios", "al registrarse").
- No incluyas cédulas, correos, teléfonos ni ningún dato personal.
- No inventes funcionalidades, causas ni fechas que no estén en el texto.
- Si la información es escasa, sé breve en vez de rellenar.
Responde SOLO con JSON válido, sin markdown.
`;

  const result = await completeJson(prompt, { temperature: 0.3 });

  return {
    headline: String(result.headline ?? title).trim() || title,
    summary: Array.isArray(result.summary)
      ? result.summary.join(" ")
      : String(result.summary ?? "").trim(),
    details: (Array.isArray(result.details) ? result.details : [])
      .map((d) => String(d).trim())
      .filter(Boolean)
      .slice(0, 3),
  };
}

/**
 * Reads a #feature-requests thread and drafts the request.
 *
 * The one rule that matters: nothing is invented. Product prioritizes from these
 * pages, so a made-up "20 médicos lo pidieron" is worse than "No indicado".
 *
 * @returns {Promise<{title: string, problem: string, areas: string[], platform: string|null, sections: Record<string, string>}>}
 */
export async function analyzeFeatureRequest(threadTitle, messages) {
  const prompt = `
Eres product manager de DocGuía, un software clínico que usan médicos y odontólogos.
Lee este thread de Discord donde el equipo registra lo que piden los médicos y
redacta la solicitud de funcionalidad.

Título del thread: "${threadTitle}"

Mensajes:
${formatConversation(messages)}

Devuelve un objeto JSON con exactamente estos campos:
- "title": en español, máximo 90 caracteres. Describe la NECESIDAD y para qué sirve,
  no solo la solución. Bien: "Recordatorios de cita por WhatsApp para reducir
  inasistencias". Mal: "WhatsApp".
- "problem": 1 a 3 frases: qué dolor tiene el médico (o quien corresponda) y para quién.
- "areas": array con 0 a 3 de estas opciones exactas: ${JSON.stringify(AREA_OPTIONS)}.
  Array vacío si ninguna aplica con claridad.
- "platform": una de ${JSON.stringify(PLATFORM_OPTIONS)}, o null si el thread no lo deja claro.
- "sections": objeto con estos campos de texto:
  - "problema": el problema con un poco más de detalle.
  - "quienLoPide": qué médico, especialidad o tipo de cliente lo pide.
  - "cuantosLoHanPedido": cuántos médicos o clientes lo han pedido, según el thread.
  - "comoLoResuelveHoy": qué hace hoy para resolverlo (workaround, otra herramienta, nada).
  - "quePidioElMedico": lo que pidió, lo más cerca posible de sus palabras.
  - "quePasaSiNo": consecuencia de no tenerlo (pierde tiempo, se va a otro software, etc.).
  - "evidencia": qué evidencia hay en el thread (capturas, videos, audios, ejemplos).

Reglas:
- NO inventes datos. Si algo no aparece en el thread, escribe exactamente "${NOT_STATED}".
  Nada de suponer cantidades, especialidades, consecuencias ni plataformas.
- Todo en español, claro y directo.
Responde SOLO con JSON válido, sin markdown.
`;

  const raw = await completeJson(prompt, { temperature: 0.2 });
  return normalizeFeatureAnalysis(raw);
}

/**
 * Sorts shortlisted items into the same thing / related / different.
 *
 * The reporter makes the final call in the review, so borderline cases are shown
 * as "related" rather than silently dropped — a real duplicate that nobody sees
 * becomes a second page, which is exactly what this is meant to prevent.
 *
 * @param {{kind: "bug"|"feature", candidate: {title: string, summary: string}, options: Array<{id: string, title: string, text: string}>}} args
 * @returns {Promise<Array<{id: string, verdict: "same"|"related", reason: string}>>} different ones left out
 */
export async function judgeDuplicates({ kind, candidate, options }) {
  const same =
    kind === "bug"
      ? "el mismo bug: mismo comportamiento roto en el mismo lugar, aunque lo describan distinto"
      : "la misma necesidad del médico, aunque pidan otra solución o uno sea más técnico que el otro";
  const related =
    kind === "bug"
      ? "misma pantalla o flujo y síntomas parecidos; podría ser la misma causa"
      : "resolver uno ayudaría claramente a resolver el otro, o se solapan en buena parte";

  const list = options
    .map((o) => `- id: ${o.id}\n  título: ${o.title}\n  detalle: ${String(o.text ?? "").slice(0, 700)}`)
    .join("\n");

  const prompt = `
Eres quien mantiene el backlog de DocGuía, un software clínico. Llegó un reporte nuevo
y hay que saber si ya existe. Compáralo con cada existente.

Reporte nuevo:
título: ${candidate.title}
detalle: ${candidate.summary}

Existentes:
${list}

Devuelve un objeto JSON:
{"matches": [{"id": "...", "verdict": "igual" | "relacionada" | "distinta", "reason": "..."}]}
con una entrada por cada existente.
- "igual": ${same}.
- "relacionada": ${related}.
- "distinta": solo comparten módulo o palabras.
- "reason": una frase corta (máximo 25 palabras) en español que explique la relación.
Responde SOLO con JSON válido, sin markdown.
`;

  const result = await completeJson(prompt, { temperature: 0 });
  const verdicts = { igual: "same", relacionada: "related" };
  return (Array.isArray(result.matches) ? result.matches : [])
    .filter((m) => m?.id && verdicts[String(m.verdict).toLowerCase()])
    .map((m) => ({
      id: String(m.id),
      verdict: verdicts[String(m.verdict).toLowerCase()],
      reason: String(m.reason ?? "").trim(),
    }));
}
