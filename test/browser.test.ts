// The built-in browser: addresses, keys, and plan mode; then, where this machine has Chromium, the page engine, Pi's
// browser tool, and the Browser panel's routes against a real browser and a small local site.
import { type App, cleanUp, fakeTab, lastText, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers, findBrowser, normalizeUrl, parseKeys, presetOf, profileFolder, snapOf, viewportFrom } from "../src/server/browser.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";

test("addresses as people type them become URLs the browser may open", () => {
	assert.equal(normalizeUrl("localhost:5173"), "http://localhost:5173/");
	assert.equal(normalizeUrl("127.0.0.1:3000/app?x=1"), "http://127.0.0.1:3000/app?x=1");
	assert.equal(normalizeUrl("192.168.1.4:8080"), "http://192.168.1.4:8080/");
	assert.equal(normalizeUrl("myserver:8080"), "http://myserver:8080/");
	assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
	assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
	assert.equal(normalizeUrl("about:blank"), "about:blank");
	for (const refused of ["", "hello world", "word", "javascript:alert(1)", "chrome://settings", "view-source:https://example.com", "file:///etc/hosts", "/etc/hosts", "data:text/html,hi"]) {
		assert.equal(normalizeUrl(refused), undefined, refused);
	}
	// Pi and the owner may open files on this machine.
	assert.equal(normalizeUrl("file:///etc/hosts", { trusted: true }), "file:///etc/hosts");
	assert.equal(normalizeUrl("./site/index.html", { trusted: true, cwd: "/work" }), "file:///work/site/index.html");
	assert.equal(normalizeUrl("/tmp/a b.html", { trusted: true }), "file:///tmp/a%20b.html");
	assert.equal(normalizeUrl("data:text/html,hi", { trusted: true }), "data:text/html,hi");
	assert.equal(normalizeUrl("javascript:alert(1)", { trusted: true }), undefined);
	assert.equal(normalizeUrl("~/site/index.html", { trusted: true, windows: false }), `file://${homedir()}/site/index.html`);
	// Backslashes and lone dots make no host.
	for (const refused of [".\\index.html", "..\\site", "\\\\server\\share", ".", "..", "-bad-.com", "a..b.com"]) {
		assert.equal(normalizeUrl(refused, { trusted: true, windows: false }), undefined, refused);
	}
});

test("on Windows, paths as Windows writes them open as files", () => {
	const windows = { trusted: true, windows: true, cwd: "C:\\work" };
	assert.equal(normalizeUrl("C:\\site\\index.html", windows), "file:///C:/site/index.html");
	assert.equal(normalizeUrl("c:/site/a b.html", windows), "file:///c:/site/a%20b.html");
	assert.equal(normalizeUrl(".\\index.html", windows), "file:///C:/work/index.html");
	assert.equal(normalizeUrl("..\\other\\index.html", windows), "file:///C:/other/index.html");
	assert.equal(normalizeUrl("./index.html", windows), "file:///C:/work/index.html");
	assert.equal(normalizeUrl("\\\\server\\share\\index.html", windows), "file://server/share/index.html");
	assert.equal(normalizeUrl("file:///C:/site/index.html", windows), "file:///C:/site/index.html");
	// Web addresses read the same; only people who may open files get paths.
	assert.equal(normalizeUrl("localhost:5173", windows), "http://localhost:5173/");
	assert.equal(normalizeUrl("C:\\site\\index.html", { windows: true }), undefined);
	assert.equal(normalizeUrl(".\\index.html", { windows: true }), undefined);
});

test("a snap browser comes last, and keeps its profile where a snap may write", () => {
	const dir = mkdtempSync(join(root, "snap-"));
	{
		const snapBin = join(dir, "snap", "bin");
		const bin = join(dir, "bin");
		const other = join(dir, "other");
		for (const folder of [snapBin, bin, other]) mkdirSync(folder, { recursive: true });
		const executable = (path: string, text: string) => {
			writeFileSync(path, text);
			chmodSync(path, 0o755);
		};
		// Ubuntu's chromium-browser: a script that runs the snap.
		executable(join(bin, "chromium-browser"), `#!/bin/sh\nif ! [ -x ${snapBin}/chromium ]; then echo "install the snap" >&2; exit 1; fi\nexec ${snapBin}/chromium "$@"\n`);
		executable(join(snapBin, "chromium"), "\u007fELF");
		executable(join(other, "google-chrome-stable"), "\u007fELF");
		const env = (path: string) => ({ PATH: path });
		const only = { snapBin, places: [] };

		assert.deepEqual(snapOf(join(bin, "chromium-browser"), snapBin), { name: "chromium", command: join(snapBin, "chromium") });
		assert.deepEqual(snapOf(join(snapBin, "chromium"), snapBin), { name: "chromium", command: join(snapBin, "chromium") });
		assert.equal(snapOf(join(other, "google-chrome-stable"), snapBin), undefined);
		if (process.platform === "linux") {
			// Chrome installed otherwise wins, though the snap's script comes first on the PATH.
			assert.equal(findBrowser(env(`${bin}:${other}`), only), join(other, "google-chrome-stable"));
			// Only the snap: its own command, not the script.
			const onlySnap = findBrowser(env(bin), only);
			assert.ok(onlySnap === join(snapBin, "chromium") || onlySnap?.includes("ms-playwright"), String(onlySnap));
		}

		// Its profile: in the snap's own folder, one per data folder, and never in a hidden folder of the home folder.
		const profile = profileFolder(join(snapBin, "chromium"), join(homedir(), ".pi-pocket"), snapBin);
		assert.match(profile, new RegExp(`^${homedir()}/snap/chromium/common/pi-pocket/[0-9a-f]{12}$`));
		assert.notEqual(profile, profileFolder(join(snapBin, "chromium"), join(homedir(), ".pi-pocket-other"), snapBin));
		assert.equal(profileFolder(join(other, "google-chrome-stable"), "/data", snapBin), "/data/browser/profile");
	}
});

test("viewports and keys are read the way people and Pi write them", () => {
	assert.deepEqual(viewportFrom("mobile"), { width: 390, height: 844, scale: 2, mobile: true });
	assert.deepEqual(viewportFrom(" Desktop "), { width: 1280, height: 800, scale: 1, mobile: false });
	assert.deepEqual(viewportFrom("1024x768"), { width: 1024, height: 768, scale: 1, mobile: false });
	assert.deepEqual(viewportFrom("360×640"), { width: 360, height: 640, scale: 1, mobile: true });
	assert.deepEqual(viewportFrom({ width: 99999, height: 10, scale: 9, mobile: true }), { width: 3840, height: 240, scale: 3, mobile: true });
	assert.equal(viewportFrom("huge"), undefined);
	assert.equal(viewportFrom({ width: "1" }), undefined);
	assert.equal(presetOf(viewportFrom("tablet")!), "tablet");
	assert.equal(presetOf(viewportFrom("1024x768")!), undefined);

	assert.deepEqual(parseKeys("Enter"), { key: "Enter", modifiers: 0 });
	assert.deepEqual(parseKeys("esc"), { key: "Escape", modifiers: 0 });
	assert.deepEqual(parseKeys("Control+Shift+a"), { key: "a", modifiers: 10 });
	assert.deepEqual(parseKeys("Meta+Enter"), { key: "Enter", modifiers: 4 });
	assert.deepEqual(parseKeys("Shift++"), { key: "+", modifiers: 8 });
	assert.throws(() => parseKeys("Hyper+a"), /Unknown modifier/);
	assert.throws(() => parseKeys("Launch"), /Unknown key/);
});

test("plan mode lets Pi look at pages but not act on them", () => {
	for (const action of ["navigate", "snapshot", "screenshot", "console", "scroll", "viewport", "back", "reload", "wait"]) {
		assert.equal(blockedInPlanMode("browser", { action }), undefined, action);
	}
	for (const action of ["click", "type", "press", "select", "evaluate"]) {
		assert.match(blockedInPlanMode("browser", { action }) ?? "", /Plan mode is on: The browser's \w+ can change things/, action);
	}
	// A data: page is one Pi writes, scripts and all.
	assert.match(blockedInPlanMode("browser", { action: "navigate", url: "data:text/html,<script>fetch('/x')</script>" }) ?? "", /Plan mode is on/);
});

// ─── With a real browser ────────────────────────────────────────────────

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;

const PAGE = `<!doctype html><html><head><title>Smoke test</title><meta name="viewport" content="width=device-width"></head><body>
<header><nav><a href="/two">Second page</a> <a href="/two" target="_blank">Popup</a></nav></header>
<main><h1>Hello</h1><p>Some intro text for the page.</p>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Sent ' + document.getElementById('email').value + ' ' + document.getElementById('pick').value">
<label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" value="old@example.com">
<select id="pick"><option value="a">Apple</option><option value="b">Banana</option></select>
<button type="submit">Send</button></form>
<div id="out"></div>
<div id="fancy" style="cursor:pointer" onclick="this.textContent='clicked div'">Fancy div</div>
<button id="confirm" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<div style="height:3000px"></div><p id="bottom">The end</p>
</main><script>console.log("hello", {a: 1}); console.error("boom"); setTimeout(() => { throw new Error("late failure") }, 10);</script></body></html>`;

let site: Server;
let base = "";

before(async () => {
	site = createServer((request, response) => {
		// A request that never ends, as some pages have (a stream, a stuck image).
		if (request.url === "/never") return;
		response.writeHead(200, { "content-type": "text/html" });
		if (request.url === "/hang") response.end(`<title>Hang</title><img src="/never"><button onclick="this.textContent='pressed'">Press</button>`);
		else response.end(request.url === "/two" ? "<title>Two</title><h1>Second</h1>" : PAGE);
	});
	await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
	base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
	site.close();
	cleanUp();
});

test("the engine reads, clicks, types in, and streams a real page, and opens it again where it was", real, async () => {
	const saved = new Map<number, { url?: string }>();
	const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "engine-")), load: async (id) => saved.get(id), save: (id, value) => saved.set(id, value) });
	const states: { url: string }[] = [];
	browsers.subscribe((_, state) => states.push(state));
	try {
		const page = await browsers.open(1);
		assert.deepEqual(await page.navigate(`${base}/`), { status: 200 });
		await until(() => page.title === "Smoke test", "the title");

		const outline = await page.snapshot();
		for (const line of ['link "Second page" -> /two', "# Hello", 'textbox "Email" = "old@example.com" [email]', 'combobox = "Apple" options: Apple | Banana', 'button "Send"', 'clickable "Fancy div"']) {
			assert.ok(outline.lines.includes(line), `the snapshot has ${line}:\n${outline.lines}`);
		}
		assert.match(outline.lines, /Some intro text for the page\./);
		assert.ok(outline.scrollHeight > 3000);

		// Typing replaces what a field holds, also in an email field a script cannot select.
		assert.equal(await page.type({ label: "Email" }, "tanner@example.com"), 'input#email "old@example.com"', "a label finds its field");
		assert.equal(await page.select({ selector: "#pick" }, "banana"), "Banana");
		const ref = /\[(e\d+)\] button "Send"/.exec(outline.lines)![1]!;
		assert.equal((await page.click({ ref })).label, 'button "Send"');
		assert.equal(await page.evaluate("document.getElementById('out').textContent"), "Sent tanner@example.com b");
		await page.click({ label: "Fancy div" });
		assert.equal(await page.evaluate("return document.getElementById('fancy').textContent"), "clicked div");
		// Dialogs are accepted, and said so.
		await page.click({ selector: "#confirm" });
		assert.equal(await page.evaluate("document.getElementById('confirm').textContent"), "yes");

		assert.equal(await page.evaluate("const r = await Promise.resolve(4); return r * 2"), "8");
		assert.equal(await page.evaluate("let n = 1; n"), "1");
		assert.equal(await page.evaluate("let n = 2; n"), "2", "names can be declared again, as in DevTools");
		assert.match(await page.evaluate("({ h1: document.querySelector('h1') })"), /"h1": "<h1>Hello<\/h1>"/);
		await assert.rejects(page.evaluate("nope()"), /ReferenceError: nope is not defined/);
		await assert.rejects(page.click({ ref: "e999" }), /No element e999 on the page now: take a new snapshot/);

		const logs = page.logs().map((entry) => `${entry.level}: ${entry.text}`);
		for (const line of ["log: hello {a: 1}", "error: boom", "error: Uncaught Error: late failure", "dialog: confirm: Sure?"]) assert.ok(logs.includes(line), `${line} in ${logs.join(" | ")}`);
		assert.equal(browsers.state(1).errors, 2);
		// Clearing is a change the panel sees, so it fetches the empty console.
		const before = browsers.state(1).logs;
		page.clearLogs();
		assert.deepEqual([page.logs(), browsers.state(1).errors, browsers.state(1).logs > before], [[], 0, true]);

		// The panel's frames are JPEGs, and its taps land where they are shown.
		const frame = (await page.frame(0))!;
		assert.deepEqual([...frame.data.subarray(0, 3)], [0xff, 0xd8, 0xff]);
		assert.deepEqual([frame.width, frame.height], [1280, 800]);
		await page.evaluate("document.getElementById('fancy').textContent = 'Fancy div'; scrollTo(0, 0)");
		const box = JSON.parse(await page.evaluate("JSON.stringify(document.getElementById('fancy').getBoundingClientRect())")) as { x: number; y: number; width: number; height: number };
		await page.input([{ type: "click", x: box.x + 5, y: box.y + box.height / 2 }]);
		assert.equal(await page.evaluate("document.getElementById('fancy').textContent"), "clicked div");
		await page.input([{ type: "wheel", x: 100, y: 100, dx: 0, dy: 400 }]);
		await until(async () => Number(await page.evaluate("scrollY")) > 0, "the scroll");

		const shot = await page.screenshot();
		assert.deepEqual([shot.width, shot.height], [1280, 800]);
		assert.ok(Buffer.from(shot.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));

		// A link to a new tab opens in this page: there is one page per conversation.
		await page.click({ label: "Popup" });
		await until(() => page.url === `${base}/two`, "the popup's page");
		assert.equal(await page.go(-1), true);
		await until(() => page.url === `${base}/`, "going back");
		// A web page cannot use a new tab to open a file here, which it could not open itself.
		await page.evaluate("window.open('file:///etc/hosts'); 1");
		// Chromium refuses it by itself; the page's own rule refuses it too, should a tab open anyway.
		await until(() => page.logs().some((entry) => /^(Not allowed to load local resource: |A new tab for )file:\/\/\/etc\/hosts/.test(entry.text)), "the refused tab");
		await new Promise((done) => setTimeout(done, 500));
		assert.equal(page.url, `${base}/`);

		await page.setViewport(viewportFrom("mobile")!);
		assert.equal(await page.evaluate("innerWidth"), "390");
		assert.match(await page.evaluate("navigator.userAgent"), /Mobile Safari/);
		assert.equal(browsers.state(1).preset, "mobile");

		// A click on a page still loading something that never ends waits for nothing the click did not start.
		assert.equal((await page.navigate(`${base}/hang`, { timeoutMs: 1000 })).slow, true);
		const started = Date.now();
		await page.click({ label: "Press" });
		assert.ok(Date.now() - started < 3000, `the click took ${Date.now() - started} ms`);
		assert.equal(await page.evaluate("document.querySelector('button').textContent"), "pressed");

		// A tab that asks with a frame number from before a restart gets the newest frame, not a long wait.
		const fresh = await page.frame(Number.MAX_SAFE_INTEGER);
		assert.ok(fresh !== undefined && fresh.seq > 0);

		// A server that never answers keeps the browser from answering too: the wait ends at its time, and says so.
		const silent = Date.now();
		assert.deepEqual(await page.navigate(`${base}/never`, { timeoutMs: 1000 }), { slow: true });
		await page.stop();
		assert.deepEqual(await page.navigate(`${base}/never`, { wait: false }), {});
		assert.ok(Date.now() - silent < 6000, `took ${Date.now() - silent} ms`);
		await page.stop();

		const refused = await page.navigate("http://127.0.0.1:9/");
		assert.match(refused.error ?? "", /ERR_CONNECTION_REFUSED|ERR_UNSAFE_PORT/);

		await page.navigate(`${base}/two`);
		await until(() => saved.get(1)?.url === `${base}/two`, "the address saved");
		await browsers.close(1);
		assert.equal(browsers.state(1).open, false);
		const again = await browsers.open(1);
		assert.equal(again.url, `${base}/two`, "a page opens again where it was");
		assert.equal(again.viewport.width, 390, "at the size it had");
		// Opened to go elsewhere, it skips loading the old address, but keeps the size.
		await browsers.close(1);
		const blank = await browsers.open(1, { restore: false });
		assert.deepEqual([blank.url, blank.viewport.width], ["about:blank", 390]);
		assert.ok(states.some((state) => state.url === `${base}/two`), "changes were announced");
	} finally {
		await browsers.closeAll({ final: true });
	}
});

test("Pi uses the browser tool, and people watch and use the same page in the panel", real, async () => {
	const results: string[] = [];
	const route: FauxResponseStep = (context) => {
		const { role, text } = lastText(context as never);
		const call = (args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall("browser", args)], { stopReason: "toolUse" });
		if (role === "toolResult") {
			results.push(text);
			return fauxAssistantMessage([fauxText("done")]);
		}
		if (text.includes("open the test page")) return call({ action: "navigate", url: base.replace("http://", ""), snapshot: true });
		if (text.includes("take a screenshot")) return call({ action: "screenshot" });
		if (text.includes("click send")) return call({ action: "click", label: "Send" });
		if (text.includes("open a closed port")) return call({ action: "navigate", url: "127.0.0.1:9" });
		return fauxAssistantMessage([fauxText("ok")]);
	};
	const app: App = await openApp(scriptedModel(route), join(root, "app"));
	const { createHandler } = await import("../src/server/http.ts");
	const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
	const viewer = app.config.addUser("Vee", "viewer");
	const guest = app.config.addUser("Gus", "guest");
	const request = (token: string, path: string, body?: unknown) =>
		fetch(`${api}/${path}`, body === undefined ? { headers: { authorization: `Bearer ${token}` } } : { method: "POST", headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
	try {
		const id = await newSession(app);
		// A model that takes images keeps the screenshot in the transcript.
		await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-vision" } });
		const tab = fakeTab(id, owner(app));
		await app.attach(tab.client);
		assert.equal(tab.last("browser")?.open, false);

		await say(app, id, "open the test page");
		await until(() => results.length === 1, "the navigate result");
		assert.match(results[0]!, new RegExp(`^Opened ${base}/ \\(HTTP 200\\)\\.`));
		assert.match(results[0]!, /\[e\d+\] button "Send"/);
		assert.match(results[0]!, /Console errors and dialogs during this call:\n- \[error\] boom/);
		assert.match(results[0]!, /Page: "Smoke test" · http:\/\/127\.0\.0\.1:\d+\/ · desktop 1280×800$/);
		await until(() => tab.last("browser")?.url === `${base}/`, "the page reaching the tab");

		await say(app, id, "take a screenshot");
		await until(() => results.length === 2, "the screenshot result");
		assert.match(results[1]!, /^Screenshot of the viewport, 1280×800 CSS pixels\./);
		const conversation = (await app.harness.conversation(id, BACKGROUND_CONTEXT))!;
		const entries = await conversation.entries({}, 256, undefined, BACKGROUND_CONTEXT);
		const shot = entries.items.find((entry) => entry.kind === "pi.tool-result" && JSON.stringify(entry.model).includes("Screenshot of the viewport"))!;
		assert.equal((await app.entryImage(id, shot.id as unknown as number, 0))?.mimeType, "image/jpeg", "Pi sees the screenshot");

		await say(app, id, "open a closed port");
		await until(() => results.length === 3, "the failed navigate");
		assert.match(results[2]!, /^Could not open http:\/\/127\.0\.0\.1:9\/: net::ERR_/);

		// Everyone who sees the session watches; only people who can steer use the page, and files are the owner's.
		await request(app.config.ownerToken, `c/${id}/browser/navigate`, { url: `${base}/` });
		const state = (await (await request(viewer.token, `c/${id}/browser`)).json()) as { open: boolean };
		assert.equal(state.open, true);
		const frame = await request(viewer.token, `c/${id}/browser/frame?after=0`);
		assert.equal(frame.status, 200);
		assert.equal(frame.headers.get("content-type"), "image/jpeg");
		assert.ok(Number(frame.headers.get("x-seq")) > 0);
		assert.equal(frame.headers.get("x-width"), "1280");
		assert.equal((await request(viewer.token, `c/${id}/browser/navigate`, { url: "example.com" })).status, 403);
		assert.equal((await request(viewer.token, `c/${id}/browser/input`, { events: [] })).status, 403);
		const file = await request(guest.token, `c/${id}/browser/navigate`, { url: "file:///etc/hosts" });
		assert.equal(file.status, 400);
		assert.match(((await file.json()) as { error: string }).error, /not a web address/);
		assert.equal((await request(guest.token, `c/${id}/browser/navigate`, { url: `${base.replace("http://", "")}/two` })).status, 200);
		await until(() => app.browsers.page(Number(id))?.url === `${base}/two`, "the guest's address");
		// What people open shows in the chat; the servers running here are the owner's to see.
		const opened = `Gus opened ${base.replace("http://", "")}/two in the browser`;
		await until(
			() => tab.events.some((each) => each.event === "chat" && (each.data.messages as { name: string; text: string }[]).some((message) => `${message.name} ${message.text}` === opened)),
			"the activity line",
		);
		assert.deepEqual(await (await request(guest.token, `c/${id}/browser/servers`)).json(), { servers: [] });
		assert.equal((await request(guest.token, `c/${id}/browser/teleport`, {})).status, 404);
		assert.equal((await request(guest.token, `c/${id}/browser/back`, {})).status, 200);
		await until(() => app.browsers.page(Number(id))?.url === `${base}/`, "going back");
		assert.equal((await request(guest.token, `c/${id}/browser/viewport`, { viewport: "tablet" })).status, 200);
		assert.equal(app.browsers.state(Number(id)).preset, "tablet");
		const consoleLines = (await (await request(viewer.token, `c/${id}/browser/console`)).json()) as { entries: { text: string }[] };
		assert.ok(consoleLines.entries.some((entry) => entry.text === "boom"));

		// Turning the Browser extension off closes the pages and the panel.
		await app.setExtensionEnabled(owner(app), "browser.ts", false);
		assert.equal(app.browsers.page(Number(id)), undefined);
		assert.equal((await request(app.config.ownerToken, `c/${id}/browser`)).status, 404);
		await app.setExtensionEnabled(owner(app), "browser.ts", true);
		// Input for a page that is not open opens nothing.
		assert.equal((await request(app.config.ownerToken, `c/${id}/browser/input`, { events: [{ type: "click", x: 1, y: 1 }] })).status, 409);
		assert.equal(app.browsers.page(Number(id)), undefined);
		const reopened = (await (await request(app.config.ownerToken, `c/${id}/browser/open`, {})).json()) as { open: boolean };
		assert.equal(reopened.open, true);
		await until(() => app.browsers.page(Number(id))?.url === `${base}/`, "the page opening where it was");
		app.detach(tab.client);
	} finally {
		server.closeAllConnections();
		server.close();
		await app.close();
	}
});

test("the browser tool says so when this machine has no browser", async () => {
	const results: string[] = [];
	const route: FauxResponseStep = (context) => {
		const { role, text } = lastText(context as never);
		if (role === "toolResult") {
			results.push(text);
			return fauxAssistantMessage([fauxText("done")]);
		}
		return fauxAssistantMessage([fauxToolCall("browser", { action: "snapshot" })], { stopReason: "toolUse" });
	};
	const { PocketApp } = await import("../src/server/app.ts");
	const model = scriptedModel(route);
	const app = await PocketApp.open({
		dataDir: mkdtempSync(join(root, "none-")),
		defaultCwd: root,
		supervised: false,
		log: () => {},
		configureModels: (models) => models.registerNativeProvider(model.provider),
		browser: null,
	});
	try {
		const id = (await newSession(app)) as ConversationId;
		assert.equal(app.browsers.available, false);
		await say(app, id, "look");
		await until(() => results.length === 1, "the result");
		assert.match(results[0]!, /No Chromium-based browser was found on this machine/);
	} finally {
		await app.close();
	}
});
