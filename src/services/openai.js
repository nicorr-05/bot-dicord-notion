import OpenAI from "openai";
import { AIError } from "../lib/errors.js";
import {
  AREA_OPTIONS,
  NOT_STATED,
  PLATFORM_OPTIONS,
  normalizeFeatureAnalysis,
} from "../lib/feature-requests.js";

const MODEL = "gpt-4o-mini";

/** Created on first use, so importing this module doesn't require an API key. */
let openai;
function client() {
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/**
 * Sends a prompt that must be answered with a JSON object and parses it. Failures
 * come back as AIError with a message that can be shown in Discord as-is.
 */
async function completeJson(prompt, { temperature = 0.2 } = {}) {
  let response;
  try {
    response = await client().chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature,
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
    return JSON.parse(response.choices[0].message.content);
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
- "title": A concise, clear bug title (max 80 chars). Keep it in the same language as the thread.
- "description": A clear summary of the bug, what happens vs what should happen (2-4 sentences). Same language as the thread.
- "priority": One of exactly: "Urgent", "High", "Medium", "Low" — based on the severity discussed.
- "stepsToReproduce": A numbered list of steps to reproduce the bug, extracted from the discussion. If not clear, write "Not specified". Same language as thread.

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
