/**
 * A throwaway Pi Pocket for checking a change by hand: the code in this folder, a data folder of its own (a temporary
 * one, deleted on exit), and a scripted model that answers "echo: …" and costs nothing; a message "run: COMMAND" makes it
 * call bash with COMMAND; `call: TOOL JSON` calls another tool with those arguments. It says what the tool said.
 * It prints sign-in links for an owner and a guest, and takes
 * runners (`pi-pocket runner`) as the real server does. Web files and extension modules reload as they do in the real server; other server changes
 * need this process restarted.
 *
 *   node test/serve.ts [port] [host]     (defaults: 8899 and 127.0.0.2)
 *
 * The default host is its own loopback address: browsers keep cookies per host, not per port, so signing in here
 * does not sign a browser out of a Pi Pocket on 127.0.0.1 or localhost.
 */
// helpers.ts first: it points Pi's folder at a temporary one before anything from src/ loads.
import { cleanUp, lastText, newSession, openApp, root, say, scriptedModel } from "./helpers.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createServer } from "node:http";
import { join } from "node:path";
import { APP_ROOT } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { watchTree } from "../src/server/reload.ts";

const port = Number(process.argv[2] ?? 8899);
const host = process.argv[3] ?? "127.0.0.2";
const app = await openApp(
    scriptedModel((context) => {
        const { role, text } = lastText(context as never);
        const command = /(?:^|] )run: ([\s\S]+)/.exec(text)?.[1];
        const tool = /(?:^|] )call: (\w+) ([\s\S]+)/.exec(text);

        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`tool said:\n${text}`)]);
        }

        if (role === "user" && tool !== null) {
            return fauxAssistantMessage([fauxToolCall(tool[1]!, JSON.parse(tool[2]!))], {
                stopReason: "toolUse",
            });
        }

        return role === "user" && command !== undefined
            ? fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" })
            : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }),
);

// PI_POCKET_TEST_LINK_BAN=<address>: start with that address banned from linking, as its third lockout leaves it, to
// look at the Runners sheet's ban list.
if (process.env.PI_POCKET_TEST_LINK_BAN) {
    app.config.runnerLinkLimits = {
        blocks: [],
        bans: [{ address: process.env.PI_POCKET_TEST_LINK_BAN, since: Date.now() - 3_600_000 }],
    };
}

const server = createServer(createHandler({ app, listen: { host, port }, restart: () => {} }));

// Runners (`pi-pocket runner`), as `src/server/main.ts` takes them.
server.on("upgrade", (request, socket, head) => {
    if (!app.runners.upgrade(request, socket, head)) {
        socket.destroy();
    }
});
const stopWatching = watchTree(join(APP_ROOT, "web"), (file) => app.reloadClients(file));

// Extension modules reload when saved, as in the real server (`app.close()` stops this).
app.loader.watch();
// Theme folders too.
app.themes.watch();

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
