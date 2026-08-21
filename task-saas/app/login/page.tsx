import { auth, isDemoAuthEnabled } from "@/auth";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/AuthForm";

export default async function LoginPage(): Promise<React.ReactElement> {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  const demoEnabled = isDemoAuthEnabled();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900">CodeMind</h1>
          <p className="mt-2 text-sm text-gray-500">Build software with AI</p>
        </div>

        <AuthForm mode="signin" demoEnabled={demoEnabled} />
      </div>
    </main>
  );
}
