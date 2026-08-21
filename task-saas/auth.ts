import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { authConfig } from "./auth.config";
import { logger } from "@/lib/logger";
import { verifyPassword } from "@/lib/auth/password";

/**
 * Authentication.
 *
 * CodeMind uses email + password accounts. Every user gets their own isolated
 * workspace, and `session.user.id` is the canonical ownership identifier used by every
 * protected route — never an email, and never anything supplied by the client.
 *
 * DEMO MODE
 * A passwordless demo sign-in still exists for local development, but it is gated
 * behind CODEMIND_DEMO_AUTH and must be requested explicitly (`demo: "true"`). It can
 * never be reached by an ordinary email/password submission, and with the flag unset
 * the branch is inert — there is no silent fallback to a shared account.
 */

export const DEMO_USER_EMAIL = "demo@example.com";

export function isDemoAuthEnabled(): boolean {
  return process.env.CODEMIND_DEMO_AUTH === "true";
}

// Runtime only: during `next build` this module is evaluated once per route bundle,
// which would repeat the warning for every one of them.
if (
  isDemoAuthEnabled() &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  logger.warn(
    "CODEMIND_DEMO_AUTH is enabled in production. The demo workspace is reachable by anyone who can load the sign-in page. Disable it unless this is an isolated demo host."
  );
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 && trimmed.length <= 320 ? trimmed : null;
}

const credentialsProvider = CredentialsProvider({
  name: "CodeMind",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
    demo: { label: "Demo", type: "text" },
  },
  async authorize(credentials) {
    // --- Demo branch: explicit opt-in only ---------------------------------
    if (credentials?.demo === "true") {
      if (!isDemoAuthEnabled()) return null;

      const demoUser = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } });
      if (!demoUser) {
        logger.warn("Demo sign-in attempted but the demo user is not seeded", {
          hint: "run: npx prisma db seed",
        });
        return null;
      }
      return { id: demoUser.id, name: demoUser.name, email: demoUser.email, image: demoUser.image };
    }

    // --- Real credentials --------------------------------------------------
    const email = normalizeEmail(credentials?.email);
    const password = typeof credentials?.password === "string" ? credentials.password : null;
    if (!email || !password) return null;

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true, image: true, passwordHash: true },
    });

    // Returning null for "no such user" and for "wrong password" alike keeps the two
    // indistinguishable to the caller, so sign-in cannot be used to enumerate accounts.
    // A user with no passwordHash (legacy or OAuth-only) has no password to verify.
    if (!user?.passwordHash) return null;

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) return null;

    return { id: user.id, name: user.name, email: user.email, image: user.image };
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [credentialsProvider],
});
