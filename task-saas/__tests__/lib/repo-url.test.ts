import { describe, it, expect } from "vitest";
import { parseRepoUrl } from "@/lib/repo/github";

/**
 * parseRepoUrl is a security boundary, not a convenience parser.
 *
 * It is the only thing between a user-supplied string and an outbound request the
 * server makes with its own credentials. Everything it accepts becomes a host this
 * deployment connects to, so the interesting cases here are not malformed URLs — they
 * are URLs that LOOK like GitHub and are not.
 *
 * These tests exist because that behaviour was previously protected by nothing. A
 * refactor that replaced the exact-host check with `includes("github.com")` would have
 * been invisible.
 */
describe("parseRepoUrl", () => {
  describe("accepts real repository URLs", () => {
    it.each([
      ["https://github.com/sindresorhus/ky", "sindresorhus", "ky"],
      ["http://github.com/sindresorhus/ky", "sindresorhus", "ky"],
      ["https://www.github.com/sindresorhus/ky", "sindresorhus", "ky"],
      // Pasted without a scheme, which is how people actually type them.
      ["github.com/sindresorhus/ky", "sindresorhus", "ky"],
      // Copied from a clone command.
      ["https://github.com/sindresorhus/ky.git", "sindresorhus", "ky"],
      // Deep links: someone pastes the file they are looking at.
      ["https://github.com/sindresorhus/ky/tree/main/source", "sindresorhus", "ky"],
      ["https://github.com/sindresorhus/ky/blob/main/readme.md", "sindresorhus", "ky"],
      ["https://github.com/sindresorhus/ky/issues/42", "sindresorhus", "ky"],
      // Query strings and fragments are not part of the identity.
      ["https://github.com/sindresorhus/ky?tab=readme", "sindresorhus", "ky"],
      ["https://github.com/sindresorhus/ky#install", "sindresorhus", "ky"],
      // Surrounding whitespace from a copy/paste.
      ["  https://github.com/sindresorhus/ky  ", "sindresorhus", "ky"],
      // Names with the punctuation GitHub allows.
      ["https://github.com/my-org/my.repo_name", "my-org", "my.repo_name"],
    ])("%s", (input, owner, name) => {
      expect(parseRepoUrl(input)).toEqual({ owner, name });
    });

    it("normalises case, so one repository has one identity", () => {
      // The index is keyed on (owner, name, commitSha). Without this, GitHub/Ky and
      // github/ky would be indexed twice and share nothing.
      expect(parseRepoUrl("https://github.com/SindreSorhus/KY")).toEqual({
        owner: "sindresorhus",
        name: "ky",
      });
    });
  });

  describe("rejects hosts that are not GitHub", () => {
    /**
     * The suffix attack is the one that matters. A check written as
     * `hostname.includes("github.com")` or `endsWith("github.com")` accepts several of
     * these, and the server would then send an authenticated request to a host the
     * attacker controls.
     */
    it.each([
      ["a different host entirely", "https://gitlab.com/foo/bar"],
      ["github.com as a subdomain of an attacker domain", "https://github.com.evil.test/foo/bar"],
      ["github.com as a path on another host", "https://evil.test/github.com/foo/bar"],
      ["a lookalike with a hyphen", "https://github-com.evil.test/foo/bar"],
      ["userinfo that ends in github.com", "https://github.com@evil.test/foo/bar"],
      ["a subdomain of github.com we do not serve", "https://gist.github.com/foo/bar"],
      ["raw content host", "https://raw.githubusercontent.com/foo/bar/main/x.ts"],
      ["a self-hosted Enterprise instance", "https://github.mycompany.test/foo/bar"],
      ["a non-http scheme", "ftp://github.com/foo/bar"],
    ])("%s: %s", (_label, input) => {
      expect(parseRepoUrl(input)).toBeNull();
    });
  });

  describe("rejects anything that is not a repository", () => {
    it.each([
      ["empty", ""],
      ["whitespace only", "   "],
      ["not a url at all", "not a url"],
      ["the host with no path", "https://github.com"],
      ["an owner with no repository", "https://github.com/sindresorhus"],
      ["a trailing slash after the owner", "https://github.com/sindresorhus/"],
    ])("%s: %s", (_label, input) => {
      expect(parseRepoUrl(input)).toBeNull();
    });
  });

  describe("rejects path segments that could escape the URL we build", () => {
    /**
     * owner and name are interpolated into an API path. A segment containing a slash,
     * a traversal, or a control character could reach an endpoint other than the one
     * intended, so they are validated against GitHub's own naming rules rather than
     * escaped and hoped for.
     */
    it.each([
      ["parent traversal as the name", "https://github.com/owner/.."],
      ["current directory as the name", "https://github.com/owner/."],
      ["an encoded slash in the name", "https://github.com/owner/re%2Fpo"],
      ["a space in the owner", "https://github.com/ow ner/repo"],
      ["a colon in the name", "https://github.com/owner/re:po"],
      ["a tilde in the owner", "https://github.com/ow~ner/repo"],
    ])("%s: %s", (_label, input) => {
      expect(parseRepoUrl(input)).toBeNull();
    });
  });
});
