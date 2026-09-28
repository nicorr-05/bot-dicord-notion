/**
 * Cheap keyword similarity, used to shortlist possible duplicates before the AI
 * judges them (and on its own when the AI is unavailable).
 */

/**
 * Words that say nothing about *which* problem it is. Without them "que el médico
 * pueda ver la agenda" and "que el médico pueda exportar informes" would look alike.
 */
const STOPWORDS = new Set(
  (
    "a al algo algun alguna algunos ante antes aqui asi aun cada como con contra cual cuando " +
    "de del desde donde dos el ella ellos en entre es esa ese eso esta este esto estos fue ha " +
    "hace hacer hay la las le les lo los mas me mi mis muy ni no nos o otra otro para pero " +
    "poco por porque puede pueda puedan poder que quien se ser si sin sobre solo su sus tambien " +
    "tan tener tiene tienen todo todos tu un una uno unos y ya " +
    "medico medicos doctor doctora paciente pacientes usuario usuarios cliente clientes " +
    "quiere quieren quisiera necesita necesitan pide piden opcion funcion funcionalidad " +
    "docguia sistema app plataforma nuevo nueva agregar permitir " +
    "error bug falla fallo problema funciona sale aparece cuando"
  ).split(" ")
);

function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Meaningful, accent-free, roughly singular words of a text. */
export function keywords(text) {
  return new Set(
    normalize(text)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      // "informes"/"informe" and "citas"/"cita" end up as the same word.
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
      .map((w) => (w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w))
  );
}

/** Strict: good enough to show on its own, without the AI's opinion. */
export const STRICT = { threshold: 0.34, minShared: 2, max: 3 };
/** Loose: a wider net for the AI to judge. */
export const SHORTLIST = { threshold: 0.2, minShared: 1, max: 6 };

/**
 * Items that share enough keywords with `query`, best first.
 *
 * Score = shared keywords / keywords of the shorter text. The shorter side is the
 * denominator because an existing item is often just a title while the new one
 * is a paragraph.
 *
 * @param {string} query
 * @param {Array<{text: string}>} items
 */
export function rankByKeywords(query, items, { threshold, minShared, max } = STRICT) {
  const wanted = keywords(query);
  if (wanted.size === 0) return [];

  return items
    .map((item) => {
      const theirs = keywords(item.text);
      const shared = [...wanted].filter((w) => theirs.has(w)).length;
      const score = theirs.size ? shared / Math.min(wanted.size, theirs.size) : 0;
      return { ...item, score, shared };
    })
    .filter((item) => item.shared >= minShared && item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
