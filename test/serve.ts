/**
 * A throwaway Pi Pocket for checking a change by hand: the code in this folder, a data folder of its own (a temporary
 * one, deleted on exit), and a scripted model that answers "echo: …" and costs nothing. It prints sign-in links for
 * an owner and a guest. Web files and extension modules reload as they do in the real server; other server changes
 * need this process restarted.
 *
 *   node test/serve.ts [port] [host]     (defaults: 8899 and 127.0.0.2)
 *
 * The default host is its own loopback address: browsers keep cookies per host, not per port, so signing in here
 * does not sign a browser out of a Pi Pocket on 127.0.0.1 or localhost.
 */
// helpers.ts first: it points Pi's folder at a temporary one before anything from src/ loads.
import { cleanUp, newSession, openApp, root, say, scriptedModel } from "./helpers.ts";
import { createServer } from "node:http";
import { join } from "node:path";
import { APP_ROOT } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { watchTree } from "../src/server/reload.ts";

const port = Number(process.argv[2] ?? 8899);
const host = process.argv[3] ?? "127.0.0.2";
const app = await openApp(scriptedModel());
const server = createServer(createHandler({ app, listen: { host, port }, restart: () => {} }));
const stopWatching = watchTree(join(APP_ROOT, "web"), (file) => app.reloadClients(file));

// Extension modules reload when saved, as in the real server (`app.close()` stops this).
app.loader.watch();

await new Promise<void>((resolve) => server.listen(port, host, resolve));
// Something to look at: a session with one exchange in it.
const session = await newSession(app);

await say(app, session, "Hello from the copy");
const guest = app.config.addUser("Guest", "guest");
const base = `http://${host}:${port}`;

console.log(`A copy of Pi Pocket, with its own data in ${root}`);
console.log(`  owner: ${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
console.log(`  guest: ${base}/login?token=${encodeURIComponent(guest.token)}`);
console.log(`Ctrl+C, or kill ${process.pid}, stops it and deletes its data.`);

const stop = async () => {
    stopWatching();
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
    process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
