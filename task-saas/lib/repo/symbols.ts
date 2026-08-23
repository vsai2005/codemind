/**
 * Exported symbol names, by regex, for JavaScript and TypeScript.
 *
 * WHY REGEX AND NOT A PARSER
 * Same posture as the rest of this feature: the cheap structural approach first, and a
 * real parser only once it demonstrably fails. An AST parser means a dependency
 * (@babel/parser or typescript itself), a large one, to read a handful of declaration
 * forms. The blind spots below are recorded so the failure is recognised when it
 * arrives rather than rediscovered.
 *
 * ONLY THE EXPORTED SURFACE
 * Local helpers are deliberately not indexed. "What implements X" is nearly always a
 * question about the public surface, and indexing every internal `const` multiplies
 * rows while diluting scoring with names no caller ever refers to.
 *
 * KNOWN BLIND SPOTS, none of which throw — they silently yield nothing:
 *   - `export * from "./other"` re-exports with no local name to record
 *   - computed or conditional exports assigned at runtime
 *   - symbol-like text inside comments or string literals, which produces FALSE
 *     positives rather than misses
 *   - decorators and unusual formatting that splits a declaration across lines
 */

/** Declarations that name their export directly. */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  // export function foo / export async function foo / export default function foo
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  // export class Foo / export default class Foo / export abstract class Foo
  /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  // export const foo / export let foo / export var foo
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  // export interface Foo / export type Foo / export enum Foo
  /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  // CommonJS: exports.foo = / module.exports.foo =
  /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm,
];

/**
 * Named export lists: `export { a, b as c }`.
 *
 * The ALIAS is what matters — `export { internalName as isPlainObject }` publishes
 * isPlainObject, and that is the name a question will use.
 */
const EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/gm;

/** `module.exports = { a, b }` — the CommonJS equivalent of an export list. */
const MODULE_EXPORTS_OBJECT = /^\s*module\.exports\s*=\s*\{([^}]*)\}/gm;

/** Names that identify nothing and would only add noise to scoring. */
const USELESS = new Set(["default", "undefined", "null", "true", "false"]);

/** Bound so a generated or minified file cannot contribute thousands of names. */
const MAX_SYMBOLS_PER_FILE = 100;

/** True for languages this extractor understands. */
export function supportsSymbols(language: string | null): boolean {
  return language === "javascript" || language === "typescript";
}

/**
 * Exported symbol names found in `source`, deduplicated and order-stable.
 *
 * Never throws: a file that cannot be scanned yields nothing, because a broken regex
 * on one file must not fail the ingestion of an entire repository.
 */
export function extractSymbols(source: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const add = (name: string | undefined): void => {
    if (!name) return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || USELESS.has(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    found.push(trimmed);
  };

  try {
    for (const pattern of DECLARATION_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        add(match[1]);
        if (found.length >= MAX_SYMBOLS_PER_FILE) return found;
      }
    }

    for (const pattern of [EXPORT_LIST, MODULE_EXPORTS_OBJECT]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        for (const part of match[1].split(",")) {
          // `a as b` publishes b; a bare `a` publishes a.
          const alias = part.includes(" as ") ? part.split(" as ")[1] : part;
          const cleaned = alias.replace(/[^A-Za-z0-9_$]/g, "");
          add(cleaned);
          if (found.length >= MAX_SYMBOLS_PER_FILE) return found;
        }
      }
    }
  } catch {
    // A pathological input is not worth failing an ingest over.
    return found;
  }

  return found;
}

/**
 * Names a file DECLARES without exporting: class members and top-level declarations.
 *
 * WHY THIS EXISTS
 * Measured on sindresorhus/ky. `source/core/Ky.ts` is 37,849 bytes, holds the entire
 * retry loop, and exports exactly ONE symbol — the class `Ky`. Asked "what happens to
 * the request body when ky retries a request?", it scored nothing at all, while files
 * that merely mention bodies were fetched instead. The file declares
 * calculateRetryDelay, retryRequest, cloneRetryOptions, cancelBody and raceBodyRead;
 * the evidence was there, and only the public contract was being indexed.
 *
 * DELIBERATELY NARROWER THAN IT COULD BE
 * A first probe swept up every `const` in the file and returned 102 names, most of them
 * local bindings inside function bodies — `result`, `text`, `url`, `chunks`,
 * `remaining`. Those name a step in an algorithm, not the purpose of a file, and
 * indexing them buries the real signal in generic vocabulary. Only two shapes are
 * taken: members declared at class-body indentation, and declarations at the top level
 * of the module.
 *
 * Exported names are extracted separately and weighted higher; anything appearing in
 * both lists is dropped from this one, so a public contract is never counted twice.
 */
export function extractInternalSymbols(source: string, exported: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>(exported);

  /** Class members: `  methodName(` / `  private async methodName(` / `  #private(`. */
  const CLASS_MEMBER =
    /^[ \t]{1,8}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|\*\s*|get\s+|set\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\s*\(/gm;

  /** Top level only — column zero, so locals inside a function body cannot match. */
  const TOP_LEVEL =
    /^(?:const|let|var|function|async function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const name = raw.replace(/^#/, "").trim();
    // Control-flow keywords read as calls at class indentation; `constructor` names
    // nothing about purpose.
    if (name.length < 3 || RESERVED.has(name) || seen.has(name)) return;
    seen.add(name);
    found.push(name);
  };

  try {
    for (const pattern of [CLASS_MEMBER, TOP_LEVEL]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        add(match[1]);
        if (found.length >= MAX_SYMBOLS_PER_FILE) return found;
      }
    }
  } catch {
    return found;
  }

  return found;
}

/** Keywords that parse as declarations or calls but name nothing. */
const RESERVED = new Set([
  "if", "for", "while", "switch", "catch", "return", "constructor", "super",
  "typeof", "instanceof", "await", "yield", "new", "delete", "void", "with",
  "function", "class", "const", "let", "var", "import", "export", "default",
]);
