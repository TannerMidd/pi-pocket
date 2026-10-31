/**
 * Updates of Pi Pocket itself: it looks for a new release every 6 hours, tells the owner, shows its notes, and updates
 * the git checkout or the global npm install to it with one tap, then restarts; it can also install new releases by itself while no session is
 * working. Its routes and screens are the owner's alone (`updates.ts` does the work).
 */
import { defineExtension } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost, WebHandler, WebRequest } from "../host.ts";
import type { UpdateStatus } from "../updates.ts";

/** How often it looks for a new release, and how long after the start it first looks. */
const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
/** How often an install that waits for the sessions to be quiet looks again, and how quiet they must have been. */
const WAIT_MS = 5 * 60 * 1000;
const QUIET_MS = 10 * 60 * 1000;

/**
 * A release the install by itself may take: one an owner could install with no question asked, with nobody at work,
 * notes that say no warning, a launcher that can go back, and not one that failed before (did not start, or did not
 * install its packages).
 */
export function installsByItself(status: UpdateStatus): boolean {
    return (
        status.busy === 0 &&
        status.available &&
        status.blockers.length === 0 &&
        status.step === undefined &&
        status.rollback &&
        status.latest?.notes !== undefined &&
        !status.latest.warning &&
        !(status.last?.ok === false && status.last.toVersion === status.latest.version)
    );
}

export default function createUpdates(host: PocketHost, web: ExtensionWeb) {
    const updates = (host as Partial<PocketHost>).updates;

    web.client("updates", { access: "owner" });

    if (updates === undefined) {
        // A server from before updates: its next start has them.
        web.route("GET", "status", () => {
            throw web.error(503, "Restart the server (menu → Restart server) to use updates");
        });

        return defineExtension({ name: "pocket-updates" });
    }

    web.settings([
        {
            name: "check",
            label: "Look for new versions",
            description:
                "Ask npm (for an npm install) or GitHub for the newest release every 6 hours, and say when there is one.",
            type: "boolean",
            default: true,
        },
        {
            name: "auto",
            label: "Install new versions by themselves",
            description:
                "Update and restart while no session has worked for 10 minutes. Never for a release whose notes have a warning, or a checkout with changes of its own.",
            type: "boolean",
            default: false,
        },
        {
            name: "beta",
            label: "Beta updates",
            description:
                "Also offer beta versions (such as 0.27.0-beta.1) before the stable release. A beta can be less tested. Off keeps stable releases only; a beta then still gets the next stable release.",
            type: "boolean",
            default: false,
        },
    ]);

    /** Errors as they are, to the owner: they say what stands in the way, and name nothing secret. */
    const handle =
        (run: (request: WebRequest) => unknown): WebHandler =>
        async (request) => {
            try {
                return await run(request);
            } catch (error) {
                // Core's refusals carry their status (`HttpError`), told by their shape: this module imports no core.
                const status = (error as { status?: unknown } | null)?.status;

                if (
                    error instanceof Error &&
                    typeof status === "number" &&
                    status >= 400 &&
                    status <= 599
                ) {
                    throw web.error(status, error.message);
                }

                throw error;
            }
        };

    web.route(
        "GET",
        "status",
        handle(() => updates.status()),
    );
    web.route(
        "POST",
        "check",
        handle(({ signal }) => updates.check(signal)),
    );
    web.route(
        "POST",
        "apply",
        handle(({ body, user }) =>
            updates.apply({
                confirmWarning: body.confirmWarning === true,
                allowBusy: body.allowBusy === true,
                by: `asked by ${user.name}`,
            }),
        ),
    );

    web.onDispose(updates.subscribe((status) => web.send("status", status)));

    /** When a session last worked: an install by itself waits until they have all been quiet a while. */
    let lastWork = Date.now();

    if (typeof host.on === "function") {
        const worked = () => {
            lastWork = Date.now();
        };

        web.onDispose(host.on("run.started", worked));
        web.onDispose(host.on("run.ended", worked));
        web.onDispose(host.on("message.sent", worked));
    }

    /** The owner wants installs by themselves, and sessions have all been quiet a while. */
    const quiet = () => web.setting("auto") === true && Date.now() - lastWork >= QUIET_MS;

    /** Install by itself: only what an owner could install with no question asked, while nobody works. */
    const autoInstall = (status: UpdateStatus) => {
        if (quiet() && installsByItself(status)) {
            void updates
                .apply({
                    by: "installed by itself",
                    // Installing packages can take minutes: someone may have started to work meanwhile. Core
                    // checks for runs going too.
                    stillWanted: () =>
                        quiet()
                            ? undefined
                            : "Someone started to work: the install by itself waits.",
                })
                .catch(() => {});
        }
    };

    const look = () => {
        if (web.setting("check") === false) {
            return;
        }

        void updates.check().then(autoInstall, () => {});
    };

    const channel = () => {
        if (
            typeof updates.setBeta !== "function" ||
            updates.beta === (web.setting("beta") === true)
        ) {
            return;
        }

        updates.setBeta(web.setting("beta") === true);
        look();
    };

    if (typeof updates.setBeta === "function") {
        updates.setBeta(web.setting("beta") === true);
    }

    web.onDispose(web.onSettings(channel));

    // Waiting for quiet sessions needs no new look at GitHub: the last one is enough.
    const wait = () => {
        if (web.setting("auto") === true) {
            void updates.status().then(autoInstall, () => {});
        }
    };

    const first = setTimeout(look, FIRST_CHECK_MS);
    const every = setInterval(look, CHECK_MS);
    const waiting = setInterval(wait, WAIT_MS);

    first.unref();
    every.unref();
    waiting.unref();
    web.onDispose(() => {
        clearTimeout(first);
        clearInterval(every);
        clearInterval(waiting);
    });

    return defineExtension({ name: "pocket-updates" });
}
