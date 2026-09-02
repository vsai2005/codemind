import { estimateTokensFromBytes, identifierWords, queryTerms } from "@/lib/ai/context-manager";

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
/**
 * Weight for a term matching a name the file DECLARES but does not export.
 *
 * Below the exported weight, because a public contract is a stronger statement of
 * purpose than a private helper — but far above zero, because it is still the name a
 * developer chose for the thing that does the work. Measured on ky: source/core/Ky.ts
 * exports one symbol (`Ky`) and declares calculateRetryDelay, retryRequest, cancelBody
 * and raceBodyRead. Indexing only the export made the file that contains the entire
 * retry loop invisible to every question about retrying.
 */
const INTERNAL_SYMBOL_WEIGHT = 12;

/**
 * Bonus per DISTINCT query term a file matches, however it matched.
 *
 * This is what separates breadth from depth. The weights above stack for a single term
 * — a file both named `body.ts` and exporting `getBodySize` collects twice for "body" —
 * which rewards a file that says one thing loudly. Asked "what happens to the request
 * body when ky retries a request", the right answer is the file covering retry AND body
 * AND request, not the one covering body twice.
 *
 * Without this, measured on the real fixtures: body.ts 37, Ky.ts 35. The file with the
 * retry loop loses to the file that merely mentions bodies, by two points.
 */
const COVERAGE_BONUS = 8;
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

/**
 * How many top-scoring files are expanded along import edges.
 *
 * Small on purpose. Expansion is a bet that the question's answer sits NEXT TO its
 * best keyword match, and that bet is only good where the match itself is strong —
 * expanding the tenth-best match spends budget on a guess about a guess.
 */
const EDGE_SEED_LIMIT = 4;

/** Neighbours taken from any one seed, so a hub file cannot fill the whole list. */
const EDGE_NEIGHBOURS_PER_SEED = 3;

/** Neighbours added in total, whatever the shape of the graph. */
const EDGE_NEIGHBOURS_TOTAL = 8;

export interface IndexedFile {
  path: string;
  size: number;
  language: string | null;
  /** Names the file declares internally — class members and top-level declarations. */
  internalSymbols?: readonly string[];
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
  /**
   * True when this file was reached along an import edge rather than by matching.
   *
   * An explicit flag rather than inferring it from `score === 0`, which was wrong on
   * the fallback path: fallbackFiles gives EVERY file a score of 0, so the inference
   * silently reported zero graph contribution on exactly the path where the graph
   * changes the most. A measurement that reads zero when the feature is working is
   * worse than no measurement.
   */
  viaGraph?: boolean;
}

/**
 * Can this row ever be worth fetching? Only if the indexer recognised it as source.
 *
 * `language: null` is `languageForPath`'s verdict that a file has no recognised source
 * extension — READMEs, lockfiles, licences, dotfiles, binaries. They are indexed so the
 * file list stays an honest picture of the repository, but reading one spends a GitHub
 * request and a share of the context budget to tell the model nothing.
 *
 * DELIBERATELY REDUNDANT with the `NOT: { language: null }` clause in the chat route's
 * query. That clause was the only thing enforcing this, which made it a single point of
 * failure: nothing here re-checked, so a caller that forgot it — or a refactor that
 * dropped it — would silently put prose in front of the model with no error at all.
 * `fallbackFiles` made that worst: it runs precisely when scoring finds nothing, on the
 * vaguest questions, and orders by depth and size, so a root-level README outranks code
 * nested under source/. The query should still filter, so the database returns less;
 * this makes the filter's absence impossible rather than merely unlikely.
 */
function isSelectableSource(file: IndexedFile): boolean {
  return Boolean(file.language);
}

/**
 * Split a path segment or a symbol into lowercase words, breaking on separators AND
 * camelCase. One rule for both, because `isPlainObject` and `is-plain-object` name the
 * same thing and a question says "plain object" either way.
 *
 * The splitting itself is `identifierWords`, shared with `queryTerms` so the index and
 * the question cannot tokenize differently — they did, and an exact symbol name scored
 * zero as a result. Stemming stays here: it is a scoring concern, and scoreFiles
 * applies the same stem to the question's terms.
 */
function pathWords(segment: string): string[] {
  return identifierWords(segment).map(stem);
}

/**
 * Reduce a word to a form that survives pluralisation, and nothing more.
 *
 * Deliberately the most conservative rule that solves the observed problem: the
 * question said "retries" and the code says "retry", and exact matching missed the one
 * term that distinguished the file containing the retry loop from a file that merely
 * mentions bodies.
 *
 * It must NOT collapse words that merely share a prefix. request/require and
 * policy/police are different concepts, and a stemmer aggressive enough to merge them
 * makes every question match more files and rank none of them well. Only plural
 * suffixes are removed, which is why `-es` is stripped only after a sibilant: naive
 * `-es` stripping turns "requires" into "requir" and stops it matching "require".
 */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Rank indexed files against a question.
 *
 * Terms that appear in a large fraction of paths are dropped first — without that, a
 * question mentioning "app" or "src" ranks the whole repository and the top results
 * are whatever happened to sort first.
 */
export function scoreFiles(files: readonly IndexedFile[], question: string): ScoredFile[] {
  // Stemmed on both sides: the question's words and the file's words have to meet in
  // the same form or the match never happens.
  const terms = Array.from(new Set(queryTerms(question).map(stem)));

  // Dropped before anything else, so an unrecognised file cannot be scored AND cannot
  // skew the ubiquity ratio below — that share is only meaningful over files that were
  // candidates in the first place. Without this a question mentioning "readme" scored
  // readme.md on its basename and returned it.
  const candidates = files.filter(isSelectableSource);
  if (terms.length === 0 || candidates.length === 0) return [];

  // How many paths contain each term at all, used to discount structural vocabulary.
  const documentFrequency = new Map<string, number>();
  const wordsByPath = new Map<
    string,
    { base: string[]; dirs: string[]; symbols: string[]; internal: string[] }
  >();

  for (const file of candidates) {
    const slash = file.path.lastIndexOf("/");
    const base = pathWords(file.path.slice(slash + 1));
    const dirs = slash > 0 ? pathWords(file.path.slice(0, slash)) : [];
    const symbols = (file.symbols ?? []).flatMap((symbol) => pathWords(symbol));
    const internal = (file.internalSymbols ?? []).flatMap((symbol) => pathWords(symbol));
    wordsByPath.set(file.path, { base, dirs, symbols, internal });

    const present = new Set([...base, ...dirs, ...symbols, ...internal]);
    for (const term of terms) {
      if (present.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const ubiquitous =
    candidates.length >= MIN_FILES_FOR_UBIQUITY_FILTER
      ? new Set(
          terms.filter(
            (term) => (documentFrequency.get(term) ?? 0) > candidates.length * UBIQUITOUS_TERM_RATIO
          )
        )
      : new Set<string>();

  const filtered = terms.filter((term) => !ubiquitous.has(term));

  // Discarding every term leaves nothing to rank on, which is worse than ranking on
  // common ones: the caller gets no files rather than imperfect files. When the filter
  // would empty the set, it has misjudged and is ignored.
  const useful = filtered.length > 0 ? filtered : terms;

  const scored: ScoredFile[] = [];

  for (const file of candidates) {
    const words = wordsByPath.get(file.path);
    if (!words) continue;

    let score = 0;
    let termsMatched = 0;

    for (const term of useful) {
      const before = score;
      if (words.symbols.includes(term)) score += SYMBOL_WEIGHT;
      else if (words.internal.includes(term)) score += INTERNAL_SYMBOL_WEIGHT;
      if (words.base.includes(term)) score += BASENAME_WEIGHT;
      else if (words.base.some((w) => w.includes(term))) score += BASENAME_WEIGHT / 2;
      if (words.dirs.includes(term)) score += DIRECTORY_WEIGHT;
      if (file.language && file.language === term) score += LANGUAGE_WEIGHT;
      if (score > before) termsMatched++;
    }

    // Breadth across the question, on top of depth on any one term.
    score += termsMatched * COVERAGE_BONUS;

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
  maxFiles: number,
  /**
   * Resolved import edges, when a graph exists for this snapshot.
   *
   * THIS IS WHERE EDGES EARN THEIR KEEP. The depth-ordered sweep below is an admitted
   * guess — "shallow and large" is a proxy for importance, chosen because nothing
   * better was available. A file the entry point actually imports is not a proxy: it is
   * the code the entry point runs, which is exactly how a person reads an unfamiliar
   * repository. So neighbours of the entry points rank ABOVE that sweep and below the
   * entry points themselves.
   *
   * Nothing here outranks a file that matched the question, because this function only
   * runs when NO file matched the question.
   */
  edges: readonly FileEdgeLink[] = []
): ScoredFile[] {
  // Filtered once, up front, so neither the entry-point pass nor the depth-ordered
  // sweep below can reach an unrecognised file. Entry points are not language-checked
  // where they are detected, so a repository whose entry point resolves to a non-source
  // file would otherwise surface one here.
  const candidates = files.filter(isSelectableSource);

  const byPath = new Map(candidates.map((f) => [f.path, f]));
  const chosen: ScoredFile[] = [];

  for (const path of entryPoints) {
    const file = byPath.get(path);
    if (file && !chosen.some((c) => c.path === path)) chosen.push({ ...file, score: 0 });
    if (chosen.length >= maxFiles) return chosen;
  }

  // One hop out from the entry points, before falling back to depth ordering.
  if (edges.length > 0 && chosen.length > 0) {
    const seeds = chosen.map((c) => c.path);
    for (const file of neighboursOf(seeds, candidates, edges, new Set(seeds))) {
      if (chosen.length >= maxFiles) return chosen;
      chosen.push({ ...file, score: 0, viaGraph: true });
    }
  }

  const remaining = candidates
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
 * Files that look like hubs, from the import graph alone.
 *
 * TIER 3 of entry-point detection, used only when the repository declares nothing and
 * matches no convention. A file that many others import and that imports few things
 * itself is where the repository's shared meaning lives — which is the same thing an
 * entry point is for, arrived at from evidence rather than from a filename.
 *
 * Ranked by inbound count descending, then by OUTBOUND ascending: between two files
 * imported equally often, the one that pulls in less is nearer the bottom of the stack
 * and explains more per line. Path breaks the remaining ties so the ordering is total
 * and cannot depend on edge order.
 *
 * Returns nothing when there are no edges. A repository with no graph has no structural
 * evidence, and inventing an entry point from path shape would be the guess this tier
 * exists to replace.
 */
export function hubFiles(
  files: readonly IndexedFile[],
  edges: readonly FileEdgeLink[],
  limit: number
): string[] {
  if (edges.length === 0) return [];

  const selectable = new Set(files.filter(isSelectableSource).map((f) => f.path));
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();

  for (const edge of edges) {
    if (edge.fromPath === edge.toPath) continue;
    if (selectable.has(edge.toPath)) inbound.set(edge.toPath, (inbound.get(edge.toPath) ?? 0) + 1);
    if (selectable.has(edge.fromPath)) {
      outbound.set(edge.fromPath, (outbound.get(edge.fromPath) ?? 0) + 1);
    }
  }

  return Array.from(inbound)
    .sort((a, b) => {
      const byInbound = b[1] - a[1];
      if (byInbound !== 0) return byInbound;
      const byOutbound = (outbound.get(a[0]) ?? 0) - (outbound.get(b[0]) ?? 0);
      if (byOutbound !== 0) return byOutbound;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([path]) => path);
}

/** One resolved import edge, reduced to the two paths it connects. */
export interface FileEdgeLink {
  /** The importing file. */
  fromPath: string;
  /** The imported file. Only resolved edges appear here — see FileEdge in the schema. */
  toPath: string;
}

/**
 * Files one import hop from `seeds`, ranked deterministically.
 *
 * RANKING RULE: how many of the seeds reference the file, descending; then
 * dependencies before dependents; then path, ascending.
 *
 * Chosen over the obvious alternatives because on this data both of those are
 * CONSTANT and would rank nothing:
 *   - edge kind: the query that loads these filters `kind: "resolved"`, so every
 *     candidate has the same kind.
 *   - distance from a scored file: expansion is a single hop, so every candidate is
 *     at distance 1.
 * Seed count is the one signal that actually varies. A file imported by two of the
 * top matches is shared ground between them, which is a better guess at "the code
 * that explains this area" than a file only one match happens to touch.
 *
 * Insertion order is deliberately NOT used, and the final path tie-break makes the
 * ordering total: two runs over the same edges in a different order rank identically.
 * A selection that varied between identical turns would make a wrong answer
 * impossible to reproduce.
 *
 * Bounded per seed and in total, because a hub module in a real repository has
 * hundreds of importers and unbounded expansion would turn "read the relevant files"
 * into "read the repository".
 */
function neighboursOf(
  seeds: readonly string[],
  files: readonly IndexedFile[],
  edges: readonly FileEdgeLink[],
  /**
   * Paths already selected, which callers MUST include the seeds in — both do.
   *
   * That requirement is what makes a self-import a non-event here: the seed is
   * excluded, so an edge from a file to itself can never add it a second time.
   */
  exclude: ReadonlySet<string>
): IndexedFile[] {
  const byPath = new Map(files.filter(isSelectableSource).map((f) => [f.path, f]));

  // Adjacency built once. Rebuilding it per seed would be quadratic on the edge list.
  const imports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  for (const edge of edges) {
    (imports.get(edge.fromPath) ?? imports.set(edge.fromPath, []).get(edge.fromPath)!).push(
      edge.toPath
    );
    (
      importedBy.get(edge.toPath) ?? importedBy.set(edge.toPath, []).get(edge.toPath)!
    ).push(edge.fromPath);
  }

  /** Per candidate: which seeds reached it, and whether any reached it as a dependency. */
  const stats = new Map<string, { seeds: Set<string>; dependency: boolean }>();

  for (const seed of seeds.slice(0, EDGE_SEED_LIMIT)) {
    // Dependencies first so the per-seed cap, when it bites, keeps the code the seed
    // RUNS over the code that merely calls it.
    const reachable: Array<[string, boolean]> = [
      ...(imports.get(seed) ?? []).slice().sort().map((p): [string, boolean] => [p, true]),
      ...(importedBy.get(seed) ?? []).slice().sort().map((p): [string, boolean] => [p, false]),
    ];

    let fromThisSeed = 0;
    for (const [path, isDependency] of reachable) {
      if (fromThisSeed >= EDGE_NEIGHBOURS_PER_SEED) break;
      if (exclude.has(path)) continue;
      // Absent when the edge points at a file the caller did not load — one outside the
      // scan limit, or without a recognised source extension. Skipped rather than
      // fetched: this module may only choose among files it was given.
      if (!byPath.has(path)) continue;

      const entry = stats.get(path) ?? { seeds: new Set<string>(), dependency: false };
      if (!stats.has(path)) fromThisSeed++;
      else if (!entry.seeds.has(seed)) fromThisSeed++;
      entry.seeds.add(seed);
      entry.dependency = entry.dependency || isDependency;
      stats.set(path, entry);
    }
  }

  return Array.from(stats)
    .sort((a, b) => {
      const bySeedCount = b[1].seeds.size - a[1].seeds.size;
      if (bySeedCount !== 0) return bySeedCount;
      const byDirection = Number(b[1].dependency) - Number(a[1].dependency);
      if (byDirection !== 0) return byDirection;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, EDGE_NEIGHBOURS_TOTAL)
    .map(([path]) => byPath.get(path)!);
}

/**
 * Widen the strongest matches along the import graph, reserving one slot for the graph.
 *
 * WHY A RESERVED SLOT AND NOT A LONGER LIST
 * The previous version appended neighbours after every scored file. That made "a
 * neighbour never displaces a match" structurally true and the feature structurally
 * INERT: with a three-file cap and three or more scored files, no neighbour was ever
 * reachable. Measured on sindresorhus/ky — identical selection with and without edges.
 *
 * So the best-ranked neighbour is placed at the LAST guaranteed slot instead of after
 * everything. With `maxFiles` of 3 the order becomes:
 *
 *   scored[0], scored[1], bestNeighbour, scored[2], scored[3], …, remaining neighbours
 *
 * The two strongest matches still outrank the graph, always. What the neighbour
 * displaces is the THIRD-best keyword match — and that is the trade this change is
 * making, stated rather than buried: one hop from a strong match is a better bet than
 * the third file that merely shares a word with the question.
 *
 * Raising the cap was rejected instead. The cap bounds GitHub fetches per turn, which
 * are paid on every question, whereas the benefit of a fourth file only materialises
 * on some. Reordering costs nothing extra.
 *
 * If the reserved neighbour does not fit the token budget, `selectWithinBudget` skips
 * it and takes the next candidate, so a reserved slot is never a wasted one.
 *
 * Returns `scored` unchanged when there are no edges — the behaviour of a repository
 * indexed before edges existed, which must not change.
 */
export function expandAlongEdges(
  scored: readonly ScoredFile[],
  files: readonly IndexedFile[],
  edges: readonly FileEdgeLink[],
  /**
   * The caller's per-turn file cap. The reservation is placed relative to it, because
   * "the last guaranteed slot" is only meaningful against the number of slots.
   */
  maxFiles: number
): ScoredFile[] {
  if (scored.length === 0 || edges.length === 0) return [...scored];

  const chosen = new Set(scored.map((f) => f.path));
  const neighbours = neighboursOf(
    scored.map((f) => f.path),
    files,
    edges,
    chosen
  ).map((file) => ({ ...file, score: 0, viaGraph: true }));

  if (neighbours.length === 0) return [...scored];

  // At least one scored file always precedes the reservation, however small the cap:
  // the top match is never displaced by adjacency.
  const reserveAt = Math.max(1, Math.min(maxFiles - 1, scored.length));
  const [best, ...rest] = neighbours;

  return [...scored.slice(0, reserveAt), best, ...scored.slice(reserveAt), ...rest];
}

/**
 * Take the highest-scoring files that fit a token allowance.
 *
 * Budgeted from the stored byte size rather than by fetching and measuring, so no
 * request is spent on a file that would not have fit. The estimate is deliberately
 * pessimistic: a file charged too little is fetched and then dropped by the context
 * packer, which spends a GitHub request for nothing.
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
    const projected = estimateTokensFromBytes(file.size);
    if (used + projected > allowanceTokens) continue;
    used += projected;
    selected.push(file);
  }

  return selected;
}
