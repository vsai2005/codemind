"use client";

import { useCallback, useId, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

/**
 * Sign-in / sign-up form.
 *
 * Both modes live in one component so the toggle is local state rather than a
 * navigation: switching between "Sign In" and "Create Account" keeps whatever the
 * user has already typed and never round-trips to the server.
 *
 * Failed sign-ins deliberately report ONE generic message ("Incorrect email or
 * password.") regardless of the underlying cause. Distinguishing "no account with
 * that email" from "wrong password" turns the login form into an account-enumeration
 * oracle: an attacker could probe addresses and learn which ones are registered,
 * which is both a privacy leak and a targeting aid for credential stuffing. Only
 * registration — where the user is deliberately claiming an address — surfaces the
 * server's specific "already taken" message, because there the collision is
 * information the person in front of the form needs in order to proceed.
 *
 * Validation runs client-side before the request purely as a fast path for typos;
 * the server re-validates everything and remains the authority.
 */

interface AuthFormProps {
  /** Which mode the form opens in. Toggling afterwards is local state. */
  mode: "signin" | "signup";
  /** Whether the passwordless local demo account is available. */
  demoEnabled: boolean;
}

type Mode = "signin" | "signup";

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

const GENERIC_SIGNIN_ERROR = "Incorrect email or password.";
const MIN_PASSWORD_LENGTH = 8;

/** Deliberately permissive: the server and the mail provider are the real judges. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Pull `{ error }` off a JSON body without trusting its shape. */
function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const candidate = (body as Record<string, unknown>).error;
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return fallback;
}

export function AuthForm({ mode, demoEnabled }: AuthFormProps): React.ReactElement {
  const router = useRouter();

  const [currentMode, setCurrentMode] = useState<Mode>(mode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const baseId = useId();
  const nameId = `${baseId}-name`;
  const emailId = `${baseId}-email`;
  const passwordId = `${baseId}-password`;
  const nameErrorId = `${nameId}-error`;
  const emailErrorId = `${emailId}-error`;
  const passwordErrorId = `${passwordId}-error`;

  const isSignup = currentMode === "signup";

  const toggleMode = useCallback(() => {
    setCurrentMode((prev) => (prev === "signin" ? "signup" : "signin"));
    setFieldErrors({});
    setFormError(null);
  }, []);

  /** Returns the errors found; an empty object means the form may be submitted. */
  const validate = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};

    if (isSignup && name.trim().length === 0) {
      errors.name = "Please enter your name.";
    }
    if (email.trim().length === 0) {
      errors.email = "Please enter your email address.";
    } else if (!looksLikeEmail(email.trim())) {
      errors.email = "Please enter a valid email address.";
    }
    if (password.length === 0) {
      errors.password = "Please enter your password.";
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }

    return errors;
  }, [email, isSignup, name, password]);

  /** Shared post-authentication step for every successful path. */
  const goToDashboard = useCallback(() => {
    router.push("/dashboard");
    router.refresh();
  }, [router]);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;

    const errors = validate();
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    const trimmedEmail = email.trim();
    setSubmitting(true);

    try {
      if (isSignup) {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), email: trimmedEmail, password }),
        });

        if (!res.ok) {
          // 400 (validation) and 409 (email taken) both carry a usable message.
          const body: unknown = await res.json().catch(() => null);
          setFormError(readErrorMessage(body, "Could not create your account. Please try again."));
          return;
        }

        // Registered, but not yet signed in — establish the session from here.
        const result = await signIn("credentials", {
          email: trimmedEmail,
          password,
          redirect: false,
        });

        if (result?.error) {
          setFormError("Your account was created, but sign-in failed. Please sign in.");
          setCurrentMode("signin");
          return;
        }

        goToDashboard();
        return;
      }

      const result = await signIn("credentials", {
        email: trimmedEmail,
        password,
        redirect: false,
      });

      if (result?.error) {
        // One message for every failure mode — see the note at the top of this file.
        setFormError(GENERIC_SIGNIN_ERROR);
        return;
      }

      goToDashboard();
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDemo = async (): Promise<void> => {
    if (submitting) return;

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);

    try {
      const result = await signIn("credentials", { demo: "true", redirect: false });
      if (result?.error) {
        setFormError("Could not open the demo workspace.");
        return;
      }
      goToDashboard();
    } catch {
      setFormError("Could not open the demo workspace.");
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = (hasError: boolean): string =>
    `block w-full rounded-[6px] border bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition-colors placeholder:text-gray-400 focus:border-gray-400 focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500 ${
      hasError ? "border-red-300" : "border-gray-300"
    }`;

  return (
    <div className="space-y-5">
      {formError && (
        <div
          role="alert"
          className="rounded-[6px] border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-900"
        >
          {formError}
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {isSignup && (
          <div className="space-y-1.5">
            <label htmlFor={nameId} className="block text-sm font-medium text-gray-700">
              Name
            </label>
            <input
              id={nameId}
              name="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? nameErrorId : undefined}
              className={inputClass(Boolean(fieldErrors.name))}
            />
            {fieldErrors.name && (
              <p id={nameErrorId} className="text-xs text-red-600">
                {fieldErrors.name}
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor={emailId} className="block text-sm font-medium text-gray-700">
            Email
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? emailErrorId : undefined}
            className={inputClass(Boolean(fieldErrors.email))}
          />
          {fieldErrors.email && (
            <p id={emailErrorId} className="text-xs text-red-600">
              {fieldErrors.email}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor={passwordId} className="block text-sm font-medium text-gray-700">
            Password
          </label>
          <input
            id={passwordId}
            name="password"
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? passwordErrorId : undefined}
            className={inputClass(Boolean(fieldErrors.password))}
          />
          {fieldErrors.password ? (
            <p id={passwordErrorId} className="text-xs text-red-600">
              {fieldErrors.password}
            </p>
          ) : (
            isSignup && (
              <p className="text-xs text-gray-400">At least {MIN_PASSWORD_LENGTH} characters.</p>
            )
          )}
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-[6px] bg-gray-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting && (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          )}
          {isSignup ? "Create Account" : "Sign In"}
        </button>
      </form>

      <p className="text-center text-sm text-gray-500">
        {isSignup ? "Already have an account? " : "Don't have an account? "}
        <button
          type="button"
          onClick={toggleMode}
          disabled={submitting}
          className="rounded font-medium text-gray-900 underline underline-offset-2 transition-colors hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSignup ? "Sign In" : "Sign Up"}
        </button>
      </p>

      {demoEnabled && (
        <div className="space-y-4">
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-gray-200" />
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400">or</span>
            <span className="h-px flex-1 bg-gray-200" />
          </div>

          <button
            type="button"
            onClick={() => void onDemo()}
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Continue as demo user
          </button>

          <p className="text-center text-xs leading-relaxed text-gray-400">
            Demo mode opens a shared local workspace without a password. Not intended for
            network-reachable deployments.
          </p>
        </div>
      )}
    </div>
  );
}
