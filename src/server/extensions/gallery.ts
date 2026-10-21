/**
 * The extension gallery: find drop-ins and themes other people wrote in a reviewed index, install them (drop-ins off),
 * read their code, ask Pi to review it, update them with a diff, remove them, and share your own. Its routes are the
 * owner's alone; the web app shows it in Menu → Extensions and as the launcher's Find extensions (`gallery.ts` does the
 * work).
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { HttpError } from "../errors.ts";
import type { ExtensionWeb, PocketHost, WebHandler, WebRequest } from "../host.ts";

/**
 * An extension's name in the index, as a route's `:name` (`NAME` in `gallery/entry.ts`). Kept here rather than imported:
 * this module also loads into a running server from before the gallery, until its restart, whose `reload.ts` lacks what
 * `entry.ts` imports.
 */
const NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** A theme's id, as a route's `:id` (`THEME_ID` in `themes/format.ts`). */
const THEME_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
/** A drop-in's module file, as a route's `:file`. */
const FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\.ts$/;
/** How often the index is read again while extensions from it are installed, so a revoked one is told soon. */
const CHECK_MS = 12 * 60 * 60 * 1000;

export default function createGallery(host: PocketHost, web: ExtensionWeb) {
    const gallery = (host as Partial<PocketHost>).gallery;

    if (gallery === undefined) {
        // A server from before the gallery: its next start has it.
        web.route("GET", "index", () => {
            throw web.error(503, "Restart the server (menu → Restart server) to use the gallery");
        });

        return defineExtension({ name: "pocket-gallery" });
    }

    /** The gallery's errors as they are, to the owner: they say what went wrong, and name nothing secret. */
    const handle =
        (run: (request: WebRequest) => unknown): WebHandler =>
        async (request) => {
            try {
                return await run(request);
            } catch (error) {
                if (error instanceof HttpError) {
                    throw web.error(error.status, error.message);
                }

                throw error;
            }
        };

    const name = (request: WebRequest) => {
        const value = request.params.name ?? "";

        if (!NAME.test(value)) {
            throw web.error(400, "That is not the name of an extension in the gallery");
        }

        return value;
    };

    web.route(
        "GET",
        "index",
        handle(({ query }) => gallery.listing(query.get("refresh") === "1")),
    );
    web.route(
        "GET",
        "installed",
        handle(() => gallery.installed()),
    );
    web.route(
        "GET",
        "source/:name",
        handle((request) => gallery.source(name(request), request.signal)),
    );
    web.route(
        "POST",
        "install/:name",
        handle((request) => gallery.install(name(request), request.body.pin, request.signal)),
    );
    web.route(
        "GET",
        "update/:name",
        handle((request) => gallery.updatePreview(name(request), request.signal)),
    );
    web.route(
        "POST",
        "update/:name",
        handle((request) =>
            gallery.update(name(request), request.body.pin, request.body.enabled, request.signal),
        ),
    );
    web.route(
        "POST",
        "uninstall/:name",
        handle((request) => gallery.uninstall(request.user, name(request))),
    );
    web.route(
        "GET",
        "review/:name",
        handle((request) => gallery.review(name(request))),
    );
    web.route(
        "GET",
        "share/:file",
        handle((request) => {
            const file = request.params.file ?? "";

            if (!FILE.test(file)) {
                throw web.error(400, "That is not a drop-in's module file");
            }

            return gallery.share(file);
        }),
    );
    web.route(
        "GET",
        "share-theme/:id",
        handle((request) => {
            const id = request.params.id ?? "";

            if (!THEME_ID.test(id)) {
                throw web.error(400, "That is not a theme's id");
            }

            return gallery.shareTheme(id);
        }),
    );
    web.route(
        "GET",
        "settings",
        handle(() => gallery.settings()),
    );
    web.route(
        "POST",
        "settings",
        handle(({ body }) => gallery.setIndex(body.index)),
    );

    // Revoked versions: look again a minute after the start, then twice a day. Nothing is read with none installed.
    const look = () => void gallery.check().catch(() => {});
    const first = setTimeout(look, 60_000);
    const every = setInterval(look, CHECK_MS);

    first.unref();
    every.unref();
    web.onDispose(() => {
        clearTimeout(first);
        clearInterval(every);
    });

    return defineExtension({ name: "pocket-gallery" });
}
