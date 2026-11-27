import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
    defineExtension,
    GenerationTask,
    hook,
    LiveDoc,
    type Storage,
} from "@earendil-works/pi-durable";
import { noWait } from "./limit-gate.ts";
import { requestPerson } from "./requests.ts";

interface PersonalCredential {
    apiKey: string;
    headers?: Record<string, string>;
}

/** Resolve a complete set of request credentials for a trusted gateway provider. */
export interface TurnCredentials {
    provider: string;
    baseUrl: string;
    resolve(
        userId: string,
    ): PersonalCredential | undefined | Promise<PersonalCredential | undefined>;
}

export function turnCredentialRouting(
    models: ModelRuntime,
    credentials: TurnCredentials,
    submission: Storage["submission"],
) {
    // Durable 1.6 passes the task's cancellation signal to the model call. Keep only the actor here.
    const actors = new WeakMap<AbortSignal, string>();
    const getAuth = models.getAuth.bind(models);

    models.getAuth = async (model, options) => {
        if (typeof model === "string") {
            // There is no server-wide credential to advertise for the personal provider.
            return model === credentials.provider ? undefined : getAuth(model, options);
        }

        if (model.provider !== credentials.provider) {
            return getAuth(model, options);
        }

        // The native Codex provider only accepts OAuth through its regular store. Supply the
        // resolved request auth here so the host never needs a shared login or a dummy key.
        const signal = options?.signal;
        const actor = signal && actors.get(signal);

        if (actor !== undefined) {
            let personal: PersonalCredential | undefined;

            try {
                personal = await credentials.resolve(actor);
            } catch {
                // A resolver error may carry secrets. Keep its text out of the transcript.
            }

            signal?.throwIfAborted();

            if (personal?.apiKey) {
                return { auth: { ...personal, baseUrl: credentials.baseUrl } };
            }
        }

        throw new Error("No personal credential for this turn.");
    };

    // Do not replay one person's request as a cache warmer, wait on a shared quota gate,
    // or reuse an upstream response or WebSocket across accounts.
    const stream = models.streamSimple.bind(models);

    models.streamSimple = (model, transcript, options) =>
        model.provider === credentials.provider
            ? stream(
                  model,
                  transcript,
                  noWait({
                      ...options,
                      cacheRetention: "none",
                      disableContinuation: true,
                      deferred: false,
                      transport: "sse",
                  }),
              )
            : stream(model, transcript, options);

    return defineExtension({
        name: "pocket-turn-credentials",
        hooks: [
            hook(GenerationTask, {
                async beforeRequest(_request, api, context) {
                    const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
                    const first = run?.inputs[0];

                    if (first === undefined || run?.taskId !== api.taskId) {
                        return;
                    }

                    const person = requestPerson((await submission(first, context))?.requestId);

                    if (person?.wrote && context.abortSignal) {
                        actors.set(context.abortSignal, person.userId);
                    }
                },
            }),
        ],
    });
}
