import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content);

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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(response.choices[0].message.content);

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
