"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";

export function SessionProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <NextAuthSessionProvider>{children}</NextAuthSessionProvider>;
}
