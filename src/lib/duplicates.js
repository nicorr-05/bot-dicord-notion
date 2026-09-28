import { SHORTLIST, STRICT, rankByKeywords } from "./similarity.js";

/**
 * Duplicate detection shared by /ticket and /feature.
 *
 *   1. Keywords shortlist the existing items (a wide net, a handful at most).
 *   2. Optionally, each shortlisted item is enriched with more context (its page body).
 *   3. The AI reads the new report next to the shortlist and labels each one the
 *      same / related / different, saying why. Different ones are dropped.
 *
 * Whether it *is* a duplicate is still the reporter's call — this only decides what
 * gets offered. If the AI fails, the strict keyword ranking is offered instead, and
 * if everything fails the review simply shows no duplicates: finding them must
 * never block creating a ticket.
 *
 * @param {object} args
 * @param {{title: string, summary: string}} args.candidate  the new report
 * @param {Array<{id: string, title: string, text: string}>} args.items  open items to compare against
 * @param {(shortlist: object[]) => Promise<object[]>} [args.enrich]
 * @param {(args: {candidate, options}) => Promise<Array<{id: string, verdict: "same"|"related", reason: string}>>} [args.judge]
 * @returns {Promise<{matches: object[], method: "ai"|"keywords"}>}
 */
export async function findDuplicates({ candidate, items, enrich, judge }) {
  const query = `${candidate.title} ${candidate.summary}`;
  const shortlist = rankByKeywords(query, items, judge ? SHORTLIST : STRICT);
  if (shortlist.length === 0) return { matches: [], method: judge ? "ai" : "keywords" };
  if (!judge) return { matches: shortlist, method: "keywords" };

  let options = shortlist;
  if (enrich) {
    try {
      options = await enrich(shortlist);
    } catch (error) {
      console.warn(`[Duplicados] No se pudo ampliar el contexto: ${error.message}`);
    }
  }

  try {
    const verdicts = await judge({ candidate, options });
    const byId = new Map(options.map((o) => [o.id, o]));
    const matches = verdicts
      .filter((v) => byId.has(v.id))
      .map((v) => ({ ...byId.get(v.id), verdict: v.verdict, reason: v.reason }))
      // "same" before "related", then by keyword score.
      .sort((a, b) => (a.verdict === b.verdict ? b.score - a.score : a.verdict === "same" ? -1 : 1))
      .slice(0, STRICT.max);
    return { matches, method: "ai" };
  } catch (error) {
    console.warn(`[Duplicados] La IA no pudo comparar, se usan palabras clave: ${error.message}`);
    return { matches: rankByKeywords(query, items, STRICT), method: "keywords" };
  }
}

/** How a match is labelled in the review. Keyword-only matches have no verdict. */
export function verdictLabel(verdict) {
  if (verdict === "same") return "🟰 Parece lo mismo";
  if (verdict === "related") return "≈ Relacionado";
  return "🔎 Parecido por palabras";
}
