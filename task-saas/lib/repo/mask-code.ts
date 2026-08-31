/**
 * Blank out everything in a source file that is not executable code, preserving length.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOW URGENT
 * The import scanner is regex-based and matched `require("./x")` wherever it appeared —
 * including inside comments and string literals. That used to be a spurious EDGE:
 * noise in a retrieval graph, harmless. Then artifact verification started BLOCKING on
 * unresolvable specifiers, and the same noise became a refusal of a valid project that
 * the user has no way to work around. Measured, not assumed — a commented-out
 * `require("./old-helper")` produced a specifier, and a project shipping one would be
 * rejected for a line that does nothing.
 *
 * LENGTH IS PRESERVED EXACTLY, one output character per input character. That is what
 * lets the caller match against the masked text and then slice the ORIGINAL text at the
 * same offsets, so a real specifier is read from real source rather than from filler.
 * It also means nothing that counts positions — the truncation cap, the unread count —
 * sees a different file than it did before.
 *
 * THE ASYMMETRY RULE, applied throughout: where a construct is ambiguous, mask MORE
 * rather than less. Masking too much loses an import, which degrades retrieval and
 * removes an error; masking too little invents an import, which can refuse a valid
 * artifact. Those costs are not comparable, so every judgement call below leans the
 * same way.
 */

/**
 * Filler for string and template interiors.
 *
 * Deliberately not a space and not a quote: the scanner's patterns are written as
 * `[^'"]+`, so the filler has to be matchable by them while never being mistaken for a
 * delimiter. A newline would also break the line-anchored patterns, so it must be a
 * single-line character.
 */
export const MASK_FILL = "\u0001";

/** Comment interiors become spaces, which no import pattern can match. */
const COMMENT_FILL = " ";

/**
 * Characters that, as the last non-space code character, mean a following `/` opens a
 * REGEX literal rather than a division. The standard heuristic, and the only ambiguity
 * in this module that cannot be resolved without parsing.
 */
const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<",
  ">", "~", "^", "\n",
]);

/**
 * Mask comments and literal interiors in `source`.
 *
 * The returned string has the same length as the input. Delimiters — quotes, backticks,
 * comment markers — are preserved so the caller's patterns still see the shape of a
 * string; only the CONTENT is replaced.
 *
 * Never throws: a file it cannot make sense of returns as much masking as it managed,
 * which by the asymmetry rule is the safe direction.
 */
export function maskNonCode(source: string): string {
  const out: string[] = new Array(source.length);
  for (let k = 0; k < source.length; k++) out[k] = source[k];

  const n = source.length;
  let i = 0;
  /** Last non-whitespace character of actual code, for the regex-vs-division call. */
  let lastCode = "\n";

  const blank = (from: number, to: number, fill: string): void => {
    for (let k = from; k < to && k < n; k++) {
      // Newlines survive every kind of masking. The scanner's statement patterns are
      // line-anchored, so collapsing lines would change which text looks like the start
      // of a statement — a way of INVENTING matches, which is the direction this module
      // exists to avoid.
      out[k] = source[k] === "\n" ? "\n" : fill;
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // --- line comment ----------------------------------------------------
    if (ch === "/" && next === "/") {
      const start = i;
      while (i < n && source[i] !== "\n") i++;
      blank(start, i, COMMENT_FILL);
      continue;
    }

    // --- block comment ---------------------------------------------------
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      blank(start, i, COMMENT_FILL);
      continue;
    }

    // --- regex literal ---------------------------------------------------
    // Masked wholesale rather than parsed. A regex may contain quotes and comment
    // markers (`/["']|\/\//`), and leaving it as code lets those open a bogus string
    // that swallows the rest of the file. Treating a division as a regex costs at most
    // a missed import; treating a regex as code can invent one.
    if (ch === "/" && REGEX_PRECEDERS.has(lastCode)) {
      const start = i;
      let j = i + 1;
      let closed = false;
      let inClass = false;
      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break; // unterminated: not a regex after all
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        blank(start + 1, j - 1, MASK_FILL);
        i = j;
        lastCode = "/";
        continue;
      }
      // Not a regex. Fall through and treat the slash as ordinary code.
    }

    // --- string and template literals --------------------------------------
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const contentStart = i + 1;
      let j = contentStart;
      let depth = 0;

      while (j < n) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (quote === "`") {
          // `${...}` is real code and could legitimately contain a nested string, but
          // it cannot contain an import STATEMENT, and masking it costs nothing the
          // scanner wanted. Tracked only so a `}` inside interpolation does not end the
          // template early.
          if (c === "$" && source[j + 1] === "{") {
            depth++;
            j += 2;
            continue;
          }
          if (c === "}" && depth > 0) {
            depth--;
            j++;
            continue;
          }
        }
        if (c === quote && depth === 0) break;
        // A single-quoted or double-quoted string does not span lines in valid code.
        // Stopping at the newline prevents one stray apostrophe — in a comment this
        // module already blanked, or in prose — from masking the rest of the file.
        if (quote !== "`" && c === "\n") break;
        j++;
      }

      const terminated = j < n && source[j] === quote;
      blank(contentStart, j, MASK_FILL);
      i = terminated ? j + 1 : j;
      lastCode = quote;
      continue;
    }

    if (!/\s/.test(ch)) lastCode = ch;
    else if (ch === "\n") lastCode = "\n";
    i++;
  }

  return out.join("");
}
