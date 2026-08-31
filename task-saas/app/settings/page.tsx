import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { TokenUsagePanel } from "@/components/settings/TokenUsagePanel";

/**
 * Account settings.
 *
 * The app had no settings surface at all — the lifetime token total lived in the
 * account dropdown because there was nowhere else to put it. This is that page, and
 * usage is its first section; anything else account-level belongs here rather than
 * accumulating in a menu that has room for one line.
 *
 * Auth is checked server-side. The panel below fetches its own data, but the page
 * itself must not render for a signed-out visitor.
 */
export default async function SettingsPage(): Promise<React.ReactElement> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const name = session.user.name ?? session.user.email ?? "your account";

  return (
    <main className="min-h-screen bg-[#F9FAFB] px-4 py-10 md:pl-72">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium text-gray-500 transition-colors hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2"
        >
          <span aria-hidden="true">←</span> Back
        </Link>

        <h1 className="mt-4 text-xl font-semibold tracking-tight text-gray-900">Settings</h1>
        <p className="mt-1 text-[13px] text-gray-500">Signed in as {name}</p>

        <div className="mt-6 space-y-5">
          <TokenUsagePanel />
        </div>
      </div>
    </main>
  );
}
