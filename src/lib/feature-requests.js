/**
 * The Feature Requests database, as data: property names, options, and the pure
 * functions that turn an AI analysis into Notion properties, page blocks, a
 * comment, or a list of likely duplicates. Nothing here talks to an API.
 */

/** Exact names in Notion — accents and emojis included. */
export const FEATURE_PROP = {
  TITLE: "Feature",
  PROBLEM: "Problema",
  STAGE: "Etapa",
  ORIGIN: "Origen",
  AREA: "Área",
  PLATFORM: "Plataforma",
  REQUESTED_BY: "Solicitado por",
  CODE: "Código",
};

export const NEW_STAGE = "💡 Solicitud";

/** Requests in these stages are closed and never offered as a duplicate. */
export const CLOSED_STAGES = ["❌ Descartada", "🚀 Lanzada"];

export const ORIGIN_OPTIONS = [
  "Médicos / clientes",
  "Customer success",
  "Ventas",
  "Founders",
  "Data / labs",
  "Ingeniería",
];
export const DEFAULT_ORIGIN = "Médicos / clientes";

export const AREA_OPTIONS = [
  "Recipes",
  "Informes",
  "Archivos",
  "Agenda",
  "Historia clínica",
  "Odontograma",
  "Pagos",
  "Onboarding",
  "Infra",
  "Mobile",
  "Farmacias",
];

export const PLATFORM_OPTIONS = ["Mobile - Web", "Web", "Mobile"];

/** What the AI must write when the thread doesn't say. */
export const NOT_STATED = "No indicado";

/** Page body sections, in order. `key` is the field in the AI's `sections` object. */
export const BODY_SECTIONS = [
  { key: "problema", heading: "Problema" },
  { key: "quienLoPide", heading: "Quién lo pide" },
  { key: "cuantosLoHanPedido", heading: "Cuántos lo han pedido" },
  { key: "comoLoResuelveHoy", heading: "Cómo lo resuelve hoy" },
  { key: "quePidioElMedico", heading: "Qué pidió el médico" },
  { key: "quePasaSiNo", heading: "Qué pasa si no lo tenemos" },
  { key: "evidencia", heading: "Evidencia" },
];

/** Notion caps one rich_text chunk at 2000 characters. */
const RICH_TEXT_LIMIT = 2000;

// ─── Text helpers ─────────────────────────────────────────────────────────────

function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** A string, whatever the AI sent back (arrays joined, null → "No indicado"). */
function asText(value) {
  if (Array.isArray(value)) value = value.map((v) => String(v).trim()).join("\n");
  const text = String(value ?? "").trim();
  return text || NOT_STATED;
}

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Plain text → rich_text chunks under Notion's per-chunk limit. */
export function richText(text, link) {
  const s = String(text ?? "");
  const chunks = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_LIMIT) {
    chunks.push(s.slice(i, i + RICH_TEXT_LIMIT));
  }
  return (chunks.length ? chunks : [""]).map((content) => ({
    type: "text",
    text: link ? { content, link: { url: link } } : { content },
  }));
}

/** Matches an option case- and accent-insensitively; null when it isn't one. */
function snapOption(value, options) {
  const wanted = normalize(value).trim();
  return options.find((o) => normalize(o) === wanted) ?? null;
}

// ─── AI analysis ──────────────────────────────────────────────────────────────

/**
 * Cleans the AI's JSON into the shape the bot uses. Areas and platform are snapped
 * to real options (anything invented is dropped); every text field falls back to
 * "No indicado" instead of being left empty.
 */
export function normalizeFeatureAnalysis(raw = {}) {
  const sections = Object.fromEntries(
    BODY_SECTIONS.map(({ key }) => [key, asText(raw.sections?.[key])])
  );

  const areas = [
    ...new Set(
      (Array.isArray(raw.areas) ? raw.areas : [raw.areas])
        .map((a) => snapOption(a, AREA_OPTIONS))
        .filter(Boolean)
    ),
  ];

  const title = asText(Array.isArray(raw.title) ? raw.title[0] : raw.title);

  return {
    title: truncate(title, 200),
    problem: asText(raw.problem),
    areas,
    platform: snapOption(raw.platform, PLATFORM_OPTIONS),
    sections,
  };
}

// ─── Notion page ──────────────────────────────────────────────────────────────

/**
 * Properties for a new request. Only what the requester can know is filled —
 * Prioridad, Impacto, Esfuerzo, owners, Target, Diseño and the checkboxes are
 * product's call and stay empty.
 */
export function buildFeatureProperties({ title, problem, origin, areas, platform, requesterId }) {
  const properties = {
    [FEATURE_PROP.TITLE]: { title: richText(title) },
    [FEATURE_PROP.PROBLEM]: { rich_text: richText(problem) },
    [FEATURE_PROP.STAGE]: { select: { name: NEW_STAGE } },
    [FEATURE_PROP.ORIGIN]: { select: { name: origin || DEFAULT_ORIGIN } },
    [FEATURE_PROP.AREA]: {
      multi_select: (areas ?? [])
        .filter((a) => AREA_OPTIONS.includes(a))
        .map((name) => ({ name })),
    },
  };

  if (platform && PLATFORM_OPTIONS.includes(platform)) {
    properties[FEATURE_PROP.PLATFORM] = { select: { name: platform } };
  }

  if (requesterId) {
    properties[FEATURE_PROP.REQUESTED_BY] = {
      people: [{ object: "user", id: requesterId }],
    };
  }

  return properties;
}

const heading = (text) => ({
  object: "block",
  type: "heading_2",
  heading_2: { rich_text: richText(text) },
});

const paragraph = (rich) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: rich },
});

/**
 * Page body: one heading per section, the uploaded files under "Evidencia", and a
 * "Origen" footer with who asked and the Discord thread. The "Discord thread: <url>"
 * line uses the same wording as bug tickets so any tooling can parse both. The
 * pre-check note, when the reporter went ahead despite a warning, goes last.
 */
export function buildFeatureBody({ sections, requesterName, requesterDiscordId, threadUrl, evidenceBlocks = [], precheckBlocks = [] }) {
  const blocks = [];

  for (const { key, heading: text } of BODY_SECTIONS) {
    blocks.push(heading(text), paragraph(richText(sections[key] ?? NOT_STATED)));
    if (key === "evidencia") blocks.push(...evidenceBlocks);
  }

  blocks.push(
    heading("Origen"),
    paragraph([
      ...richText(
        `Solicitado por: ${requesterName}` +
          (requesterDiscordId ? ` (Discord ID: ${requesterDiscordId})` : "") +
          "\nDiscord thread: "
      ),
      ...richText(threadUrl, threadUrl),
    ]),
    ...precheckBlocks
  );

  return blocks;
}

/** "FR-12" from a unique_id property, "#12" when it has no prefix. */
export function formatCode(uniqueId) {
  if (!uniqueId || uniqueId.number == null) return null;
  return uniqueId.prefix ? `${uniqueId.prefix}-${uniqueId.number}` : `#${uniqueId.number}`;
}

/** A Notion page from the Feature Requests database → what the bot needs of it. */
export function mapFeaturePage(page) {
  const props = page.properties ?? {};
  const plain = (items) => (items ?? []).map((t) => t.plain_text).join("");

  return {
    id: page.id,
    url: page.url,
    title: plain(props[FEATURE_PROP.TITLE]?.title) || "(sin título)",
    problem: plain(props[FEATURE_PROP.PROBLEM]?.rich_text),
    stage: props[FEATURE_PROP.STAGE]?.select?.name ?? null,
    code: formatCode(props[FEATURE_PROP.CODE]?.unique_id),
  };
}

// ─── Duplicates ───────────────────────────────────────────────────────────────

/** What a request is compared on: its title and its problem. */
export function featureText({ title, problem }) {
  return `${title} ${problem}`;
}

/**
 * The comment added to an existing request when a new doctor asks for the same:
 * who asked, the gist of this thread, and the link back to it.
 */
export function buildContextComment({ analysis, requesterName, threadUrl, evidenceSummary }) {
  const s = analysis.sections;
  const text =
    `➕ Nuevo caso de la misma necesidad desde Discord — registrado por ${requesterName}\n\n` +
    `Quién lo pide: ${s.quienLoPide}\n` +
    `Problema: ${analysis.problem}\n` +
    `Qué pidió: ${s.quePidioElMedico}\n` +
    `Cómo lo resuelve hoy: ${s.comoLoResuelveHoy}\n` +
    (evidenceSummary ? `Evidencia en el thread: ${evidenceSummary}\n` : "") +
    `\nThread: `;

  // Comments share the 2000-per-chunk rule; keep the whole thing short and readable.
  return [...richText(truncate(text, 1800)), ...richText(threadUrl, threadUrl)];
}
