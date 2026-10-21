/** Manual model-list refresh: local configuration first, then independent, bounded provider catalogs. */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PocketApp } from "./app.ts";

export interface ModelRefreshResult {
    added: number;
    removed: number;
    total: number;
    offline?: true;
    errors: { provider: string; message: string }[];
}

type Bounded<T> = { value: T } | { problem: "timed out" | "failed" | "interrupted" };

/** A refresh is shared by all tabs; it never changes a session's chosen model or waits for its run. */
export class ModelRefresh {
    readonly #app: PocketApp;
    readonly #timeoutMs: number;
    #pending: Promise<ModelRefreshResult> | undefined;
    #closed = false;
    #epoch = 0;
    #refreshRuntime: ModelRuntime["refresh"] | undefined;
    readonly #controllers = new Set<AbortController>();

    constructor(app: PocketApp, timeoutMs = 8_000) {
        this.#app = app;
        this.#timeoutMs = timeoutMs;
    }

    /** Pi suppresses internally cancelled refresh errors. Track outside refreshes and credential changes so we can retry. */
    watch(models: ModelRuntime): void {
        this.#refreshRuntime = models.refresh.bind(models);

        const changed =
            <Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) =>
            (...args: Args): Promise<Result> => {
                this.#epoch++;

                return run(...args).finally(() => {
                    this.#epoch++;
                });
            };

        // Registration and unregistration also call the public refresh method, including their fire-and-forget passes.
        models.refresh = changed(models.refresh.bind(models));
        models.login = changed(models.login.bind(models));
        models.logout = changed(models.logout.bind(models));
        models.setRuntimeApiKey = changed(models.setRuntimeApiKey.bind(models));
        models.removeRuntimeApiKey = changed(models.removeRuntimeApiKey.bind(models));
    }

    refresh(): Promise<ModelRefreshResult> {
        this.#pending ??= this.#refresh().finally(() => {
            this.#pending = undefined;
        });

        return this.#pending;
    }

    async #refresh(): Promise<ModelRefreshResult> {
        // Scope belongs to Pi settings, not models.json. Read it before publishing refreshed choices.
        await this.#app.settings.reload();
        const models = this.#app.models;
        const keys = () =>
            new Set(models.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));

        if (this.#refreshRuntime === undefined) {
            this.watch(models);
        }

        const refreshRuntime = this.#refreshRuntime!;
        const before = keys();
        const errors = new Map<string, string>();
        const offline = process.env.PI_OFFLINE !== undefined;

        const result = () => {
            const after = keys();

            return {
                added: [...after].filter((key) => !before.has(key)).length,
                removed: [...before].filter((key) => !after.has(key)).length,
                total: after.size,
                ...(offline ? { offline: true as const } : {}),
                errors: [...errors].map(([provider, message]) => ({ provider, message })),
            };
        };

        // Pi treats an invalid models.json as empty. Check through its public API before reloading the live runtime,
        // so a typo does not remove working custom providers. No credentials, cache restoration or network here.
        const checked = await this.#bounded(() => ModelRuntime.create({ refreshOnCreate: false }));

        if (this.#closed) {
            return result();
        }

        if (!("value" in checked)) {
            errors.set("Configuration", `Model configuration check ${checked.problem}. Try again.`);

            return result();
        }

        if (
            /Failed to (?:load|parse) models.json|Invalid models.json schema/.test(
                checked.value.getError() ?? "",
            )
        ) {
            errors.set(
                "models.json",
                "Could not load model configuration. Check models.json and try again.",
            );

            return result();
        }

        const local = await this.#bounded(
            (signal) => refreshRuntime({ allowNetwork: false, signal }),
            Math.max(this.#timeoutMs, 8_000),
        );

        if (this.#closed) {
            return result();
        }

        if (/Availability refresh:/.test(models.getError() ?? "")) {
            // A corrupt/unreadable credential store otherwise produces the same misleading error for every catalog.
            errors.set("Sign-ins", "Could not read sign-ins. Check auth.json and try again.");
            this.#app.providers.modelsChanged();

            return result();
        }

        if (!("value" in local)) {
            errors.set("Configuration", `Model reload ${local.problem}. Try again.`);
        } else if (local.value.aborted) {
            errors.set("Configuration", "Model reload was interrupted. Try again.");
        } else {
            for (const provider of local.value.errors.keys()) {
                errors.set(provider, "Could not reload cached models. Try again.");
            }
        }

        this.#app.providers.modelsChanged();
        // Only configured providers need network discovery. Each partial refresh leaves the other providers alone,
        // publishes its result as soon as it ends, and uses Pi's existing generation-checked cache publication.
        await Promise.all(
            models
                .getProviders()
                .filter((provider) => models.hasConfiguredAuth(provider.id))
                .map(async (provider) => {
                    const refreshed = await this.#bounded(async (signal) => {
                        for (let attempt = 0; attempt < 2; attempt++) {
                            const epoch = this.#epoch;
                            const value = await refreshRuntime({
                                providers: [provider.id],
                                allowNetwork: !offline,
                                force: true,
                                signal,
                            });

                            if (signal.aborted) {
                                return value;
                            }

                            if (epoch !== this.#epoch) {
                                if (attempt === 1) {
                                    return { ...value, aborted: true };
                                }

                                continue;
                            }

                            // A sign-in fixed in Pi outside Pocket can leave an old needs-sign-in mark in Pocket.
                            if (this.#app.providers.needsSignIn(provider.id) !== undefined) {
                                await this.#app.providers.check(provider.id);
                            }

                            return value;
                        }

                        return { aborted: true, errors: new Map<string, Error>() };
                    });

                    if (this.#closed) {
                        return;
                    }

                    if (!("value" in refreshed)) {
                        errors.set(provider.id, `Refresh ${refreshed.problem}. Try again.`);
                    } else if (refreshed.value.aborted) {
                        errors.set(provider.id, "Refresh was interrupted. Try again.");
                    } else if (refreshed.value.errors.has(provider.id)) {
                        // Provider exceptions can include request headers or keys. Do not send them to a browser.
                        errors.set(
                            provider.id,
                            "Could not refresh models. Check the provider and try again.",
                        );
                    } else {
                        errors.delete(provider.id);
                    }

                    this.#app.providers.modelsChanged();
                }),
        );

        return result();
    }

    async #bounded<T>(
        run: (signal: AbortSignal) => Promise<T>,
        timeoutMs = this.#timeoutMs,
    ): Promise<Bounded<T>> {
        if (this.#closed) {
            return { problem: "interrupted" };
        }

        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        let stop: (() => void) | undefined;

        this.#controllers.add(controller);

        try {
            return await Promise.race([
                run(controller.signal).then(
                    (value) => ({ value }),
                    () => ({ problem: "failed" as const }),
                ),
                new Promise<Bounded<T>>((resolve) => {
                    stop = () => resolve({ problem: "interrupted" });
                    controller.signal.addEventListener("abort", stop, { once: true });
                    timer = setTimeout(() => {
                        resolve({ problem: "timed out" });
                        controller.abort();
                    }, timeoutMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);

            if (stop !== undefined) {
                controller.signal.removeEventListener("abort", stop);
            }

            controller.abort();
            this.#controllers.delete(controller);
        }
    }

    close(): void {
        this.#closed = true;

        for (const controller of this.#controllers) {
            controller.abort();
        }
    }
}
