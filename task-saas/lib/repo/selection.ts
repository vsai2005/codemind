import { estimateTokens, queryTerms } from "@/lib/ai/context-manager";

/**
 * Choosing which files a question needs, from the index alone.
 *
 * Runs entirely against stored rows — path, size, language — and spends no GitHub
 * request. That is the point: every candidate is ranked and budgeted BEFORE anything
 * is fetched, so the request budget is spent only on files that will actually reach
 * the model.
 *
 * WHY NOT REUSE scoreText FROM context-manager
 * `queryTerms` is shared, because splitting a question into terms is the same problem
 * here as there. `scoreText` is not, and forcing it would have been the wrong kind of
 * reuse. It counts term occurrences across a chunk of prose, which breaks on paths in
 * three ways:
 *
 *   - Common prefixes dominate. Every file in a Next.js repo lives under `app/`, so
 *     the term "app" would score the entire repository equally. Prose has no
 *     equivalent of a path segment shared by every document.
 *   - Position carries meaning. A hit in the basename is a far stronger signal than
 *     one in an intermediate directory; scoreText weights all positions the same.
 *   - Frequency across ~30 characters is noise. `auth/auth-service.ts` scoring double
 *     for "auth" reflects the directory convention, not relevance.
 *
 * So this module scores paths on their own terms. Same deterministic, no-embeddings
 * approach — a different question.
 */

/**
 * Weight for a term matching an EXPORTED SYMBOL, the strongest signal available.
 *
 * Above the basename weight deliberately. A file named `object.js` is about objects in
 * some sense; a file exporting `isPlainObject` answers "how does this decide whether a
 * value is a plain object" outright. The name a developer gave a function is a far
 * more direct statement of what it does than the name they gave its file.
 */
const SYMBOL_WEIGHT = 14;
/** Weight for a term found in the file's own name, where intent is clearest. */
const BASENAME_WEIGHT = 10;
/** Weight for a term in a directory segment. Real signal, much weaker. */
const DIRECTORY_WEIGHT = 3;
/** Weight for a term matching the extension-derived language ("typescript"). */
const LANGUAGE_WEIGHT = 2;

/**
 * Penalty for TypeScript declaration files.
 *
 * A `.d.ts` exports exactly the same symbol names as the implementation it describes,
 * so on symbols alone it ties with the real code and can win on alphabetical order.
 * But it contains signatures, not behaviour — a question about how something WORKS is
 * never answered by a type declaration. Small enough that a declaration still ranks
 * when nothing else matches, which is right for a question about a type.
 */
const DECLARATION_PENALTY = 6;

/**
 * A term shared by most of the repository says nothing about any one file. Above this
 * share it is treated as structural vocabulary and ignored for ranking.
 */
const UBIQUITOUS_TERM_RATIO = 0.4;

/**
 * Below this many candidates the ubiquity filter is skipped entirely.
 *
 * A share is only meaningful over enough files to have a shape. This was found by the
 * skeleton failing on a 15-file repository: asking "how does the index function check
 * a plain object" against `index.js`, `index.d.ts` and `index.test-d.ts` put "index"
 * in 3 of 5 source files — 60%, over the threshold — so the ONE useful term was
 * discarded as structural vocabulary and selection returned nothing at all.
 *
 * In a large repository "index" really would be noise. In a small one it is the
 * answer. The filter exists for the first case and must not fire in the second.
 */
const MIN_FILES_FOR_UBIQUITY_FILTER = 25;

/** Files nearer the root are usually more architecturally significant. */
const DEPTH_PENALTY = 0.5;

export interface IndexedFile {
  path: string;
  size: number;
  language: string | null;
  /**
   * Exported symbol names, extracted at ingest time. Empty for a repository indexed
   * before symbol extraction existed, or one whose archive could not be read — see
   * Repository.symbolsExtracted, which is what distinguishes "nothing exported" from
   * "never looked".
   */
  symbols?: readonly string[];
}

export interface ScoredFile extends IndexedFile {
  score: number;
}

/**
 * Split a path segment or a symbol into lowercase words, breaking on separators AND
 * camelCase. One rule for both, because `isPlainObject` and `is-plain-object` name the
 * same thing and a question says "plain object" either way.
 */
function pathWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Rank indexed files against a question.
 *
 * Terms that appear in a large fraction of paths are dropped first — without that, a
 * question mentioning "app" or "src" ranks the whole repository and the top results
 * are whatever happened to sort first.
 */
export function scoreFiles(files: readonly IndexedFile[], question: string): ScoredFile[] {
  const terms = queryTerms(question);
  if (terms.length === 0 || files.length === 0) return [];

  // How many paths contain each term at all, used to discount structural vocabulary.
  const documentFrequency = new Map<string, number>();
  const wordsByPath = new Map<string, { base: string[]; dirs: string[]; symbols: string[] }>();

  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const base = pathWords(file.path.slice(slash + 1));
    const dirs = slash > 0 ? pathWords(file.path.slice(0, slash)) : [];
    const symbols = (file.symbols ?? []).flatMap((symbol) => pathWords(symbol));
    wordsByPath.set(file.path, { base, dirs, symbols });

    const present = new Set([...base, ...dirs, ...symbols]);
    for (const term of terms) {
      if (present.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const ubiquitous =
    files.length >= MIN_FILES_FOR_UBIQUITY_FILTER
      ? new Set(
          terms.filter(
            (term) => (documentFrequency.get(term) ?? 0) > files.length * UBIQUITOUS_TERM_RATIO
          )
        )
      : new Set<string>();

  const filtered = terms.filter((term) => !ubiquitous.has(term));

  // Discarding every term leaves nothing to rank on, which is worse than ranking on
  // common ones: the caller gets no files rather than imperfect files. When the filter
  // would empty the set, it has misjudged and is ignored.
  const useful = filtered.length > 0 ? filtered : terms;

  const scored: ScoredFile[] = [];

  for (const file of files) {
    const words = wordsByPath.get(file.path);
    if (!words) continue;

    let score = 0;
    for (const term of useful) {
      if (words.symbols.includes(term)) score += SYMBOL_WEIGHT;
      if (words.base.includes(term)) score += BASENAME_WEIGHT;
      else if (words.base.some((w) => w.includes(term))) score += BASENAME_WEIGHT / 2;
      if (words.dirs.includes(term)) score += DIRECTORY_WEIGHT;
      if (file.language && file.language === term) score += LANGUAGE_WEIGHT;
    }

    if (score <= 0) continue;
    score -= (file.path.split("/").length - 1) * DEPTH_PENALTY;
    if (file.path.endsWith(".d.ts")) score -= DECLARATION_PENALTY;
    if (score > 0) scored.push({ ...file, score });
  }

  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * What to read when scoring finds nothing.
 *
 * THIS IS THE DEMONSTRATED CEILING OF PATH-ONLY SELECTION, not a defensive branch.
 * Measured on `sindresorhus/is-plain-obj`: asking "how does this library decide
 * whether a value is a plain object?" scores ZERO files, because the question names a
 * BEHAVIOUR and the answer lives in `index.js`, whose path contains none of those
 * words. Nothing about the file list can connect them. An earlier phrasing only worked
 * because it happened to contain the word "index".
 *
 * That is the case a symbol index would fix — matching "plain object" to the exported
 * function rather than to a filename — and it is the evidence for building one.
 *
 * Until then, entry points are the honest fallback: they are where a reader would
 * start, they are already detected during ingestion at no API cost, and reading them
 * is far better than answering a question about a repository with none of it in view.
 * Root-level source files come next, on the same reasoning — depth correlates with
 * specificity, and the top of a small repo is usually its substance.
 */
export function fallbackFiles(
  files: readonly IndexedFile[],
  entryPoints: readonly string[],
  maxFiles: number
): ScoredFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const chosen: ScoredFile[] = [];

  for (const path of entryPoints) {
    const file = byPath.get(path);
    if (file && !chosen.some((c) => c.path === path)) chosen.push({ ...file, score: 0 });
    if (chosen.length >= maxFiles) return chosen;
  }

  const remaining = files
    .filter((f) => !chosen.some((c) => c.path === f.path))
    .sort((a, b) => {
      const depth = a.path.split("/").length - b.path.split("/").length;
      return depth !== 0 ? depth : b.size - a.size;
    });

  for (const file of remaining) {
    if (chosen.length >= maxFiles) break;
    chosen.push({ ...file, score: 0 });
  }

  return chosen;
}

/**
 * Take the highest-scoring files that fit a token allowance.
 *
 * Budgeted from the stored byte size rather than by fetching and measuring, so no
 * request is spent on a file that would not have fit. The estimate is deliberately
 * pessimistic: source is punctuation-dense, and estimateTokens already leans that way
 * for code, so a file is charged roughly what it will actually cost.
 *
 * Files are never partially selected. A half-file in context reads as a complete one
 * to the model, which is how confident answers about code that was cut off happen.
 */
export function selectWithinBudget(
  scored: readonly ScoredFile[],
  allowanceTokens: number,
  maxFiles: number
): ScoredFile[] {
  const selected: ScoredFile[] = [];
  let used = 0;

  for (const file of scored) {
    if (selected.length >= maxFiles) break;
    // Bytes -> characters is 1:1 for source; estimateTokens then applies its own
    // content-aware divisor. A placeholder of the right length is enough to price it.
    const projected = estimateTokens("x".repeat(Math.max(1, file.size)));
    if (used + projected > allowanceTokens) continue;
    used += projected;
    selected.push(file);
  }

  return selected;
}
