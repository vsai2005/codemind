import { describe, it, expect } from "vitest";
import { findSecretLeak } from "@/lib/artifacts/validate";

/**
 * Secret containment on `.env.example`, which is a file of placeholders by definition.
 *
 * THE DEFECTS THIS PINS DOWN, both measured on a 42-case run.
 *
 * 1. The assignment pattern is unanchored and ran against the whole file, so a `#` two
 *    characters to the left of a name meant nothing to it. A project that had done the
 *    careful thing and commented DATABASE_URL out was rejected for assigning it.
 *
 * 2. The placeholder test read only the value's FIRST WORD. `your-secret-here` passed;
 *    `postgresql://user:password@localhost:5432/mydb` did not — the connection string
 *    Prisma's own documentation puts in `.env.example`.
 *
 * THE REAL-CREDENTIAL FIXTURES ARE THE POINT. This check exists to stop a live
 * credential leaving the server, so every relaxation below is paired with a value that
 * must still be refused. A test file containing only placeholders would pass against a
 * function that returned null unconditionally.
 */

describe("commented-out assignments", () => {
  it("accepts the exact file that was rejected", () => {
    // Verbatim from the generated blog project.
    const content = [
      "# Server Configuration",
      "PORT=3000",
      "NODE_ENV=development",
      "",
      "# JWT Configuration",
      "JWT_SECRET=your-super-secret-jwt-key-change-in-production",
      "JWT_EXPIRES_IN=7d",
      "",
      "# Database (using in-memory storage for this demo)",
      "# DATABASE_URL=mongodb://localhost:27017/blog",
    ].join("\n");

    expect(findSecretLeak(".env.example", content)).toBeNull();
  });

  it("accepts a line commented with //", () => {
    expect(
      findSecretLeak(".env.example", "// DATABASE_URL=postgresql://a:b@realhost.io/db")
    ).toBeNull();
  });

  it("accepts a commented line that is indented", () => {
    expect(
      findSecretLeak(".env.example", "   # DATABASE_URL=postgresql://a:b@realhost.io/db")
    ).toBeNull();
  });

  it("STILL refuses a real value on an uncommented line below a commented one", () => {
    // The skip must apply per line, not abandon the scan at the first comment.
    const content = [
      "# DATABASE_URL=postgresql://user:password@localhost/dev",
      "DATABASE_URL=postgresql://admin:Xk9mQ2pW@prod-db.aiven.io:5432/defaultdb",
    ].join("\n");

    expect(findSecretLeak(".env.example", content)).toMatch(/assigns a real value/);
  });

  it("does not treat a trailing # as a comment", () => {
    // Only a LEADING marker comments a line out. Otherwise a real assignment with a
    // trailing note would be waved through.
    expect(
      findSecretLeak(".env.example", "DATABASE_URL=postgresql://admin:Xk9mQ2pW@prod.aiven.io/db # set me")
    ).toMatch(/assigns a real value/);
  });
});

describe("values that announce themselves as fake", () => {
  it("accepts the canonical Prisma example, the other rejected file", () => {
    // Verbatim from the generated Prisma project.
    const content = [
      "# Database connection string for PostgreSQL",
      "# Format: postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public",
      'DATABASE_URL="postgresql://user:password@localhost:5432/mydb?schema=public"',
      "",
      "# Optional: port for the server (default 3000)",
      "# PORT=3000",
    ].join("\n");

    expect(findSecretLeak(".env.example", content)).toBeNull();
  });

  it("accepts a loopback host with a non-obvious password", () => {
    // localhost cannot leak anyone's credentials because it addresses nobody's machine.
    expect(
      findSecretLeak(".env.example", "DATABASE_URL=postgresql://app:hunter2xyz@localhost:5432/dev")
    ).toBeNull();
  });

  it("accepts a placeholder password on a non-obvious host", () => {
    // The other half of the rule, on its own: nobody's live database is reached with
    // `:password@`.
    expect(
      findSecretLeak(".env.example", "DATABASE_URL=postgresql://user:password@db.internal:5432/app")
    ).toBeNull();
  });

  it("still accepts a prefix placeholder", () => {
    // The original rule has not been dropped, only widened.
    expect(findSecretLeak(".env.example", 'AUTH_SECRET="your-secret-here-please"')).toBeNull();
  });
});

describe("real credentials are still refused", () => {
  it("refuses a live-looking connection string", () => {
    // Neither a placeholder prefix, nor a placeholder password, nor a local host.
    expect(
      findSecretLeak(".env.example", "DATABASE_URL=postgresql://admin:Xk9mQ2pW@prod.aiven.io:5432/defaultdb")
    ).toMatch(/assigns a real value to DATABASE_URL/);
  });

  it("refuses a real value on a numeric remote host", () => {
    expect(
      findSecretLeak(".env.example", "DATABASE_URL=postgres://real:S3cr3tPw@10.2.3.4:5432/prod")
    ).toMatch(/assigns a real value/);
  });

  it("refuses a substantive AUTH_SECRET", () => {
    expect(
      findSecretLeak(".env.example", "AUTH_SECRET=9f2b41c7d8e05a6b3f1029384756abcd")
    ).toMatch(/assigns a real value to AUTH_SECRET/);
  });

  it("still refuses a live API key anywhere in the file", () => {
    // A different rule, unchanged, asserted so the line-by-line rewrite did not
    // accidentally scope it to one line.
    const content = ["# harmless", "NOTES=see below", "key: nvapi-abcdefghijklmnopqrstuvwxyz012345"].join("\n");

    expect(findSecretLeak("README.md", content)).toMatch(/live API key/);
  });

  it("still refuses a real env file outright, whatever it contains", () => {
    expect(findSecretLeak(".env", "PORT=3000")).toMatch(/cannot be exported/);
    expect(findSecretLeak(".env.production", "PORT=3000")).toMatch(/cannot be exported/);
  });
});
