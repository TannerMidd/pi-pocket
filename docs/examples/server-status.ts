/**
 * Server status: a page on the rail with this machine's load, memory, and uptime, which stays live while it shows.
 * An example drop-in extension with a web part: copy it and `server-status.js` into `~/.pi-pocket/extensions/`, then
 * turn it on in Menu → Extensions.
 */
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from "node:os";
// A type import is gone when the module runs. In the drop-in folder, import the types from "./_pocket.d.ts".
import type { Web } from "../../types/pocket.d.ts";

/** What the page shows. Read here, on the server: nothing the browser could not be trusted with. */
function status() {
    return {
        host: hostname(),
        cpus: cpus().length,
        load: loadavg().map((each) => Math.round(each * 100) / 100),
        memory: { total: totalmem(), free: freemem() },
        uptime: Math.round(uptime()),
        at: Date.now(),
    };
}

export default function createServerStatus(_host: unknown, web: Web) {
    // GET /api/x/server-status/status, for the owner alone (the default).
    web.route("GET", "status", () => status());
    // The browser module beside this file, loaded in the owner's tabs.
    web.client("server-status.js");

    // A new reading every five seconds, to the tabs that load the browser module. The timer goes with this version.
    const timer = setInterval(() => web.send("status", status()), 5000);

    timer.unref();
    web.onDispose(() => clearInterval(timer));

    // No tools or hooks for Pi: this module only adds to the app.
}
