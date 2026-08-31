"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AccountUsage } from "@/components/auth/AccountUsage";
import { signOut, useSession } from "next-auth/react";

/**
 * Signed-in account footer for the sidebar.
 *
 * Shows who is signed in and offers sign-out. Everything rendered here comes from the
 * session — name, email and an initial — and nothing exposes an internal database id.
 */

function initialFor(name: string | null | undefined, email: string | null | undefined): string {
  const source = name?.trim() || email?.trim() || "";
  return source.length > 0 ? source[0]!.toUpperCase() : "?";
}

export function AccountMenu(): React.ReactElement {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (status === "loading") {
    return (
      <div className="border-t border-gray-200 bg-[#F9FAFB] p-4">
        <div className="h-7 w-32 animate-pulse rounded bg-gray-200" />
      </div>
    );
  }

  const user = session?.user;
  if (!user) {
    return (
      <div className="border-t border-gray-200 bg-[#F9FAFB] p-4">
        <a href="/login" className="text-[13px] font-medium text-gray-700 hover:text-gray-900">
          Sign in
        </a>
      </div>
    );
  }

  const displayName = user.name?.trim() || user.email || "Account";

  return (
    <div ref={containerRef} className="relative border-t border-gray-200 bg-[#F9FAFB] p-3">
      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-dropdown"
        >
          <div className="border-b border-gray-100 px-3 py-2.5">
            <p className="truncate text-[13px] font-semibold text-gray-900">{displayName}</p>
            {user.email && (
              <p className="truncate text-[11px] text-gray-500">{user.email}</p>
            )}
          </div>

          {/*
            Lifetime totals. Rendered only while the menu is open so a sidebar that is
            always mounted does not aggregate on every page load — the query is cheap
            per call, but it is not free per navigation.
          */}
          <AccountUsage />

          {/*
            The usage block above already links here — this row is for the reader who
            came looking for settings rather than for a number, and would not think to
            click a statistic to find them.
          */}
          <Link
            href="/settings"
            role="menuitem"
            className="block border-b border-gray-100 px-3 py-2.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50"
          >
            Settings
          </Link>

          <button
            type="button"
            role="menuitem"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-full px-3 py-2.5 text-left text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50"
          >
            Sign out
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[11px] font-bold text-white shadow-sm">
          {initialFor(user.name, user.email)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-gray-700">
          {displayName}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-gray-400"
          aria-hidden="true"
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
    </div>
  );
}
