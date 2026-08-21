import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDefaultModelId, listModelsForClient } from "@/lib/ai/models/registry";

/**
 * Models available to the signed-in user.
 *
 * Returns the registry's client-safe projection only: id, display name, provider
 * label, capabilities, and whether the provider is configured. It deliberately
 * carries no credential, no base URL, and no real provider model id — the mapping
 * from a CodeMind id to an upstream model stays server-side.
 *
 * A model whose provider has no key is reported as `available: false` rather than
 * omitted, so the picker can show the capability greyed out. No reason is given:
 * "which of our integrations are unconfigured" is not something to publish.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      models: listModelsForClient(),
      defaultModelId: getDefaultModelId(),
    },
    // Availability tracks server configuration, so it must not be cached at the edge.
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
