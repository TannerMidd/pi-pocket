// Server status's browser module: a button on the rail, an action in the launcher, and a page in the conversation's
// place with what `server-status.ts` reports. The app loads it and calls its default export with `pocket`, the app's
// API for extensions (docs/extensions.md).

/** The version of `pocket` this module was written for: an older app does not load it. */
export const pocketApi = 1;

/** A gauge, as a 24×24 stroked path like the app's own icons. */
const GAUGE = "M4 18a8 8 0 1116 0M12 18l4-6";

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

function since(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export default function setup(pocket) {
    const { html, useEffect, useState, Loader } = pocket;

    /** The page: loading, then the numbers, or what went wrong, with Refresh. */
    function ServerStatus() {
        const [status, setStatus] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);

        const refresh = async () => {
            setBusy(true);

            try {
                setStatus(await pocket.api("status"));
                setError(null);
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        useEffect(() => {
            void refresh();

            // The server module sends a new reading every few seconds; stop listening when the page closes.
            return pocket.on("status", setStatus);
        }, []);

        if (error) {
            return html`<div class="error-box">${error}</div>
                <button class="button" onClick=${refresh}>Try again</button>`;
        }

        if (!status) {
            return html`<${Loader} label="Reading the server" />`;
        }

        const used = status.memory.total - status.memory.free;
        const rows = [
            ["Host", status.host],
            ["Load", `${status.load.join(" · ")} on ${status.cpus} CPUs`],
            ["Memory", `${gib(used)} of ${gib(status.memory.total)} used`],
            ["Up", since(status.uptime)],
        ];

        return html`<div class="server-status">
            ${rows.map(
                ([label, value]) =>
                    html`<div class="setting">
                        <div class="grow small">${label}</div>
                        <div class="mono small">${value}</div>
                    </div>`,
            )}
            <p class="muted small">Read at ${new Date(status.at).toLocaleTimeString()}.</p>
            <button class="button" disabled=${busy} onClick=${refresh}>Refresh</button>
        </div>`;
    }

    pocket.page({ id: "status", title: "Server status", component: ServerStatus });
    pocket.rail({ id: "status", title: "Server status", iconPath: GAUGE, page: "status" });
    pocket.launcher({
        id: "status",
        label: "Server status",
        detail: "load, memory, uptime",
        iconPath: GAUGE,
        page: "status",
    });
}
