/**
 * Version of the logic that derives data from a repository snapshot.
 *
 * WHY THIS EXISTS
 * Snapshot reuse is keyed on commit SHA alone: same commit, skip everything. That is
 * correct while the derivation code is fixed and wrong the moment it improves. The
 * import scanner changed three times in one session, and an already-ingested repository
 * kept serving edges built by the old one — including phantom edges from commented-out
 * code — with nothing marking it stale and nothing that would ever re-derive it.
 *
 * ONE VERSION FOR ALL DERIVED DATA, not one per derivation.
 *
 * Per-derivation stamps would let a scanner change re-derive imports without touching
 * symbols. They would save nothing worth having: every derivation reads the SAME
 * tarball, and fetching that tarball is the entire cost. Once it is in memory, running
 * the symbol extractor as well is CPU measured in milliseconds. Splitting the stamp
 * would add three columns and a matrix of partial-staleness states to avoid work that
 * is already free.
 *
 * A HAND-INCREMENTED CONSTANT, not a hash of the modules.
 *
 * A content hash cannot tell a behaviour change from a comment edit, and this codebase
 * is written with very long explanatory comments — every documentation fix would
 * invalidate every repository and trigger a full re-derivation of all of them. That is
 * not a theoretical risk here; it is what would happen on the next edit.
 *
 * The constant's failure mode is that someone changes an extractor and forgets to bump
 * it. That is caught in CI rather than in production: __tests__ hashes the derivation
 * modules and compares against DERIVATION_SOURCE_DIGEST below. A mismatch fails the
 * build with instructions, and the developer decides whether the change was behavioural
 * (bump the version AND the digest) or cosmetic (update the digest alone). The decision
 * stays with a human, which is the point — a hash would make it automatically, and
 * automatically wrong.
 */

/**
 * Increment when a change to the derivation modules changes their OUTPUT.
 *
 * History, so the reason for each bump is recoverable:
 *   1  first versioned build. Includes the comment/literal masker, scan-confidence
 *      reporting, and widened entry-point detection. Everything indexed before this
 *      stamp existed is `null` and is treated as stale.
 */
export const DERIVATION_VERSION = 1;

/**
 * Modules whose behaviour the version covers.
 *
 * Listed rather than globbed so adding a new derivation module is a deliberate act that
 * shows up in review, instead of silently widening what the digest watches.
 */
export const DERIVATION_SOURCE_FILES: readonly string[] = [
  "lib/repo/imports.ts",
  "lib/repo/mask-code.ts",
  "lib/repo/symbols.ts",
  "lib/repo/structure.ts",
];

/**
 * Digest of those files, as of the current DERIVATION_VERSION.
 *
 * Updated together with any change to the files above. When only comments moved, update
 * this and leave the version alone; when behaviour moved, update both. The test that
 * enforces it explains which is which at the point of failure.
 */
export const DERIVATION_SOURCE_DIGEST =
  "59935cea377d4b3157982d17e6142ca3202dfcdcc57f57fd08b83880fa94e69a";

/**
 * Is a stored stamp current?
 *
 * `null` — a row written before versioning existed — is STALE, never current. It is the
 * majority case on any database that predates this change, and treating unknown as
 * up-to-date would make the whole mechanism a no-op exactly where it is needed.
 */
export function isDerivationCurrent(stamp: number | null | undefined): boolean {
  return typeof stamp === "number" && stamp >= DERIVATION_VERSION;
}
