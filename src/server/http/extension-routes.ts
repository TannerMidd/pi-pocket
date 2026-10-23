/**
 * What extension modules add to the app over HTTP: `/api/x/:module/…`, the routes a module registered (after the API's
 * sign-in, and with the `X-Pocket` header on every method), and `/x/:module/:rev/…`, the files of its browser module.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { describe, HttpError } from "../errors.ts";
import { exposedError, MAX_FILE_BYTES } from "../extension-web.ts";
import { ExtensionRequest } from "../extension-request.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationWebRequest, WebSession } from "../host.ts";
import { type ApiRequest, json, readChecked, readJson, send, SVG_CSP } from "./io.ts";

/** A request to a module's route: `parts` is the path after `/api/x/`. */
export async function extensionRoute(
    { app, request, response, url, user }: ApiRequest,
    parts: string[],
): Promise<void> {
    // First, on a GET too: the sign-in cookie goes along with a link from another site, and a module's GET may change
    // things. The app's own calls always send the header. Before the route is looked up, so such a request learns
    // nothing of the routes.
    if (request.headers["x-pocket"] !== "1") {
        throw new HttpError(403, "Missing X-Pocket header");
    }

    const [module, ...path] = parts;
    const method = request.method ?? "GET";
    // Only routes this person may use: one they may not is not there for them (404), and its methods are not told.
    const match = module === undefined ? undefined : app.webs.match(module, method, path, user);

    if (match === undefined) {
        throw new HttpError(404, "Unknown extension route");
    }

    if ("allow" in match) {
        response.setHeader("allow", match.allow.join(", "));

        throw new HttpError(405, `That route takes ${match.allow.join(", ")}`);
    }

    const { route, part, params } = match;

    // The path was decoded before it was split, so `..%2F` is a part `..`: a handler that makes a file's path of a
    // part must never get one that leads elsewhere.
    if (
        Object.values(params).some(
            (value) =>
                value === "." || value === ".." || value.includes("\\") || value.includes("\0"),
        )
    ) {
        throw new HttpError(400, "Bad path");
    }

    const body =
        method === "GET" || method === "DELETE"
            ? {}
            : await readJson<Record<string, unknown>>(request);
    const source = route.conversation === undefined ? undefined : params[route.conversation];

    if (
        source !== undefined &&
        (!/^[1-9]\d*$/.test(source) || !Number.isSafeInteger(Number(source)))
    ) {
        throw new HttpError(400, "Bad source conversation id");
    }

    const id = source === undefined ? undefined : (Number(source) as unknown as ConversationId);
    const scope = new ExtensionRequest(app, user.id, route.access, id);
    const clientCancelled = new AbortController();

    // Preserve the existing signal's disconnect-only lifetime, including while the answer is being sent.
    response.once("close", () => {
        if (!response.writableFinished) {
            clientCancelled.abort();
            scope.close();
        }
    });

    if (response.destroyed || request.aborted) {
        clientCancelled.abort();
        scope.close();
    }

    let result: unknown;

    try {
        await app.harness.commit(
            (tx) => scope.authorize(tx, id !== undefined && method !== "GET"),
            scope.context,
        );

        const agent = id === undefined ? undefined : await app.agentState(id);

        const current = scope.current();

        if (id !== undefined) {
            scope.bindSource(agent ?? {});
        }

        const bound =
            id === undefined
                ? {}
                : {
                      conversation: {
                          id,
                          title: app.sessionMeta(id)!.title ?? "New session",
                          cwd: agent?.cwd ?? app.cwdOf(id),
                          ...(agent?.model === undefined
                              ? {}
                              : { model: structuredClone(agent.model) }),
                          thinkingLevel: agent?.thinkingLevel ?? "off",
                      },
                      linkedSessions: app.linkedSessions.forRequest(id, scope),
                  };
        const input = {
            method: route.method,
            params,
            query: url.searchParams,
            body,
            user: { id: current.id, name: current.name, role: current.role },
            signal: clientCancelled.signal,
            context: scope.context,
            snapshot: scope.snapshot,
            commit: scope.commit,
            // Read when the handler asks, as the person is then: a copy, so the handler cannot change the list.
            sessions: (): WebSession[] =>
                app.sessions(scope.current()).map((session) => ({
                    id: session.id,
                    title: session.title ?? "New session",
                    cwd: session.cwd,
                    archived: session.archived === true,
                    updatedAt: session.updatedAt,
                })),
            ...bound,
        };

        result = await route.handle(input as ConversationWebRequest);
    } catch (error) {
        // The browser went away: nobody waits for an answer, and the handler stopping is no failure.
        if (clientCancelled.signal.aborted) {
            return;
        }

        return failed(response, error, part.file, user);
    } finally {
        scope.close();
    }

    let text: string | undefined;

    try {
        text = JSON.stringify(result ?? {}) as string | undefined;
    } catch (error) {
        return failed(
            response,
            new Error(`its answer is not JSON: ${describe(error)}`),
            part.file,
            user,
        );
    }

    send(response, 200, text ?? "{}", "application/json");
}

/**
 * Answer with what a handler threw: `web.error` or a core request API's HttpError, as it is; anything else, a 500 whose
 * words only the owner gets. A library's error can carry a `status` and words not meant for everyone (a provider's 401 that quotes a
 * key): only `web.error` or a core HttpError says they are. A 500 is logged here, with the extension's own stack, and answered here, so the
 * HTTP layer does not log it again.
 */
function failed(response: ServerResponse, error: unknown, file: string, user: User): void {
    const exposed = error instanceof HttpError ? error : exposedError(error);

    if (exposed !== undefined) {
        if (exposed.status >= 500) {
            console.error(`Extension ${file} answered ${exposed.status}:`, error);
        }

        json(response, exposed.status, { error: exposed.message });

        return;
    }

    console.error(`Extension ${file} failed to answer:`, error);
    json(response, 500, {
        error:
            user.role === "owner"
                ? `${file} failed: ${describe(error)}`
                : "The extension failed to answer.",
    });
}

/** A file of a module's browser module: `parts` is the path after `/x/`, its version first and then the file's path. */
export function extensionFile(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    parts: string[],
    user: User | undefined,
): void {
    if (user === undefined) {
        throw new HttpError(401, "Sign in first");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Files are only read");
    }

    const [module, _rev, ...path] = parts;
    // Someone who may not load it learns nothing of it.
    const found = module === undefined ? undefined : app.webs.file(module, path, user);

    if (found === undefined) {
        throw new HttpError(404, "Not found");
    }

    // The very file that was checked: a folder on its way swapped for a link after the check would lead elsewhere.
    const body = readChecked(
        found,
        MAX_FILE_BYTES,
        `A browser module's file is at most ${MAX_FILE_BYTES / 1024 / 1024} MB`,
    );

    // The address holds the version, but a restart starts the versions again: always ask.
    // Another site's page may not use it, not even as a script: the sign-in cookie would go along with the request.
    send(response, 200, body, found.type, {
        "cache-control": "private, no-cache",
        "cross-origin-resource-policy": "same-origin",
        ...(found.type === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
    });
}
