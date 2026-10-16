/**
 * The DGX Spark cluster's dashboard, proxied: `gx10-a6b9:8200/api/status` already aggregates both nodes, and the
 * browser cannot fetch it directly (the app's content-security policy keeps `connect-src` to itself). One cached
 * fetch every few seconds serves every open window, and it works through Tailscale HTTPS too.
 */
import { env } from "node:process";

/** The dashboard's status endpoint; `SPARK_DASHBOARD_URL` overrides it. */
const SPARK_URL = env.SPARK_DASHBOARD_URL ?? "http://gx10-a6b9:8200/api/status";

/** How long a cached status is fresh, and how long a fetch may take. */
const TTL_MS = 5_000;
const TIMEOUT_MS = 4_000;

type Cached = { at: number; data: unknown };
let cache: Cached | undefined;
let inflight: Promise<unknown> | undefined;

/** The cluster status, from the up-to-5s cache or a fresh fetch. Throws when the dashboard is unreachable. */
export async function sparkStatus(): Promise<unknown> {
    if (cache !== undefined && Date.now() - cache.at < TTL_MS) {
        return cache.data;
    }

    if (inflight !== undefined) {
        return inflight;
    }

    inflight = (async () => {
        try {
            const response = await fetch(SPARK_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });

            if (!response.ok) {
                throw Object.assign(new Error(`HTTP ${response.status}`));
            }

            const data = await response.json();

            cache = { at: Date.now(), data };

            return data;
        } finally {
            inflight = undefined;
        }
    })();

    return inflight;
}
