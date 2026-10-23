/**
 * Configurable web search, public-page extraction, crawl and research with tiered fallback and observed request usage.
 * Requires Pi Pocket 0.20.0 and its experimental host.fetchPublic API. Keys and settings belong to this extension.
 */
import { join } from "node:path";
import type { Host, Web } from "./_pocket.d.ts";
import { WebAccessManager } from "./web-search/manager.ts";
import createTools from "./web-search/tools.ts";
import type { WebSearchConfig } from "./web-search/manager.ts";

export const pocketApi = 2;

export default function createWebSearch(host: Host, web: Web) {
    if (typeof host.fetchPublic !== "function") {
        throw new Error(
            "Web search requires Pi Pocket 0.20.0+ and experimental host.fetchPublic; no unsafe fetch fallback is available.",
        );
    }

    const manager = new WebAccessManager(join(host.dataDir, "web-search"), host);

    web.onDispose(() => manager.dispose());

    const handle = (run: () => Promise<unknown>) =>
        run().catch((error: unknown) => {
            const failure = error as { status?: number; message?: string };

            throw web.error(
                failure.status === 400 ? 400 : 502,
                failure.status === 400
                    ? (failure.message ?? "Invalid web search settings")
                    : "The web search operation failed. Check the provider configuration and try again.",
            );
        });

    web.route("GET", "state", () => handle(() => manager.getState()));
    web.route("POST", "state", async ({ body: input }) => {
        const body = input as {
            apiKey?: { provider: string; key: string };
            primaryProvider?: string;
            providerOrder?: string[];
        } & Partial<WebSearchConfig>;

        return handle(async () => {
            const {
                apiKey,
                primaryProvider,
                providerOrder,
                enabled,
                maxResults,
                tierRouting,
                extractOrder,
                providerSettings,
                operations,
            } = body;

            if (apiKey !== undefined) {
                if (typeof apiKey?.provider !== "string" || typeof apiKey?.key !== "string") {
                    throw web.error(400, "An API key needs a provider and a text key");
                }

                await manager.setApiKey(apiKey.provider, apiKey.key);
            } else {
                await manager.saveConfig({
                    ...Object.fromEntries(
                        Object.entries({
                            enabled,
                            maxResults,
                            tierRouting,
                            extractOrder,
                            providerSettings,
                            operations,
                        }).filter(([, value]) => value !== undefined),
                    ),
                    ...(primaryProvider !== undefined ? { provider: primaryProvider } : {}),
                    ...(providerOrder !== undefined
                        ? { searchRouting: { providers: providerOrder } }
                        : {}),
                });
            }

            return manager.getState();
        });
    });
    web.route("POST", "test", async ({ body: input }) => {
        const body = input as { provider: string; apiKey?: string };

        return handle(() => manager.testConnection(body.provider, body.apiKey));
    });
    web.route("POST", "search", async ({ body: input }) => {
        const body = input as {
            query: string;
            provider?: string;
            numResults?: number;
            tier?: "quick" | "standard" | "deep";
            mode?: string;
        };

        return handle(() =>
            manager.search(body.query, body.provider, body.numResults, {
                tier: body.tier,
                mode: body.mode,
                purpose: "tester",
            }),
        );
    });
    web.client("web-search");

    return createTools(host, manager);
}
