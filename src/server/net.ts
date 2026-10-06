import { EventEmitter } from "node:events";
import * as undici from "undici";

const ignore = (_error: unknown): void => {};

function quiet<T extends undici.Dispatcher>(dispatcher: T): T {
    // Undici can emit an internal "error" while ending a mid-stream body; the stream still rejects on its own.
    if (dispatcher instanceof EventEmitter) {
        EventEmitter.prototype.on.call(dispatcher, "error", ignore);
    }

    return dispatcher;
}

/**
 * The HTTP setup Pi uses for provider streams: generous idle timeouts, proxies from the environment, and fetch on the
 * same undici as the dispatcher. Without it, some long provider streams break off early.
 */
export function configureHttp(idleTimeoutMs = 300_000, httpProxy?: string): void {
    const proxy = httpProxy?.trim();

    if (proxy) {
        process.env.HTTP_PROXY ??= proxy;
        process.env.HTTPS_PROXY ??= proxy;
    }

    const dispatcher = quiet(
        new undici.EnvHttpProxyAgent({
            allowH2: false,
            proxyTunnel: true,
            bodyTimeout: idleTimeoutMs,
            headersTimeout: idleTimeoutMs,
            connect: { autoSelectFamilyAttemptTimeout: 2_000 },
            clientFactory: (origin: string | URL, options: object) =>
                quiet(new undici.Client(origin, options as undici.Client.Options)),
            factory: (origin: string | URL, options: object) => {
                const pool = options as undici.Pool.Options;

                return pool.connections === 1
                    ? quiet(new undici.Client(origin, pool))
                    : quiet(
                          new undici.Pool(origin, {
                              ...pool,
                              factory: (o: string | URL, opts: object) =>
                                  quiet(new undici.Client(o, opts as undici.Client.Options)),
                          }),
                      );
            },
        } as undici.EnvHttpProxyAgent.Options),
    );

    undici.setGlobalDispatcher(dispatcher);
    undici.install?.();
}
