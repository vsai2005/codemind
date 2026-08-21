import { z } from "zod";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { enforceRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Account creation.
 *
 * Deliberately does NOT sign the user in. The client calls signIn() after a 201, which
 * keeps session establishment in one place (the credentials provider) rather than
 * duplicating it here.
 *
 * The password is hashed before it touches the database and is never logged, never
 * echoed back, and never stored in any other form.
 */

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "Name is too long"),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(320),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(MAX_PASSWORD_LENGTH, `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`),
});

export async function POST(request: Request): Promise<Response> {
  try {
    // Sign-up is unauthenticated, so it is rate limited by client IP. Without this,
    // account creation is an open door for automated abuse.
    const limited = enforceRateLimit("upload", request, null);
    if (limited) return limited;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid details" },
        { status: 400 }
      );
    }

    const { name, email, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    try {
      const user = await prisma.user.create({
        data: { name, email, passwordHash },
        // Never select passwordHash into anything that could be serialised.
        select: { id: true, email: true, name: true },
      });

      logger.info("Account created", { userId: user.id });

      return NextResponse.json(
        { user: { id: user.id, name: user.name, email: user.email } },
        { status: 201 }
      );
    } catch (error) {
      // Unique constraint on User.email. Relying on the constraint rather than a
      // read-then-write closes the race where two simultaneous sign-ups both see the
      // address as free.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return NextResponse.json(
          { error: "An account with this email already exists." },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    logger.error("Registration failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Could not create the account." }, { status: 500 });
  }
}
