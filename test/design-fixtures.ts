// Designs for the Design workspace's tests and for looking at it by hand: pages with `data-pid`s and a tweaks manifest, a
// deck, and a group of variations, written straight into a session's artifacts (as `publish` in `artifacts.ts` leaves them).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "../src/server/app.ts";
import { type ArtifactMeta, ArtifactBodyDoc, ArtifactsDoc } from "../src/server/docs.ts";

const tweaks = (accent: string) =>
    JSON.stringify([
        { name: "--accent", label: "Accent", type: "color", value: accent },
        {
            name: "--radius",
            label: "Corners",
            type: "range",
            min: 0,
            max: 32,
            step: 1,
            unit: "px",
            value: 12,
        },
        {
            name: "--scale",
            label: "Text size",
            type: "range",
            min: 0.8,
            max: 1.4,
            step: 0.05,
            value: 1,
        },
        { name: "shout", label: "Shout", type: "toggle", value: false },
        { name: "--tone", label: "Tone", type: "select", value: "calm", options: ["calm", "bold"] },
    ]);

/** A landing page: `data-pid`s on what matters, five tweaks, and a button that logs a tap to the page title. */
export const landing = (headline: string, accent = "#3b6cf6") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Landing</title>
<style>
:root { --accent: ${accent}; --radius: 12px; --scale: 1; }
* { box-sizing: border-box; }
body { margin: 0; font: calc(16px * var(--scale))/1.5 system-ui, sans-serif; color: #1c1e26; background: #f6f7fb; }
header { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; }
.logo { font-weight: 800; }
.hero { padding: 56px 24px; text-align: center; }
h1 { margin: 0 0 12px; font-size: 2.4em; line-height: 1.1; }
p { margin: 0 auto 24px; max-width: 34ch; color: #4a4f63; }
.cta { display: inline-block; border: 0; padding: 14px 26px; color: #fff; font: inherit; font-weight: 700; background: var(--accent); border-radius: var(--radius); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; padding: 0 24px 48px; }
.card { padding: 20px; background: #fff; border-radius: var(--radius); box-shadow: 0 1px 3px rgb(0 0 0 / 0.08); }
</style></head><body>
<header data-pid="nav"><span class="logo" data-pid="logo">Roast &amp; Co</span><a href="#" data-pid="login">Log in</a></header>
<section class="hero" data-pid="hero">
<h1 data-pid="headline">${headline}</h1>
<p data-pid="sub">Small batches, roasted on Tuesdays, at your door by Friday.</p>
<button class="cta" data-pid="cta">Start my box</button>
</section>
<section class="cards" data-pid="cards">
<div class="card" data-pid="card-1"><strong>Ethiopia</strong><br>Blueberry, jasmine</div>
<div class="card" data-pid="card-2"><strong>Colombia</strong><br>Panela, orange</div>
<div class="card" data-pid="card-3"><strong>Sumatra</strong><br>Cedar, dark cocoa</div>
</section>
<script type="application/json" id="pocket-tweaks">${tweaks(accent)}</script>
<script>
addEventListener("pocket:tweak", (event) => {
    if (event.detail.name === "shout") { document.querySelector("h1").style.textTransform = event.detail.value ? "uppercase" : ""; }
});
</script>
</body></html>`;

/** A deck of four 16:9 slides. */
export const deck = () => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="pocket-kind" content="deck"><title>Pitch</title>
<style>
body { margin: 0; font: 28px/1.4 system-ui, sans-serif; }
.slide { width: 1280px; height: 720px; padding: 80px; box-sizing: border-box; color: #fff; }
.slide h1, .slide h2 { margin: 0 0 20px; font-size: 64px; }
.slide:nth-of-type(1) { background: #243b6b; } .slide:nth-of-type(2) { background: #6b2438; }
.slide:nth-of-type(3) { background: #1f5a44; } .slide:nth-of-type(4) { background: #4a3a1c; }
</style></head><body>
<section class="slide" data-pid="s1"><h1 data-pid="s1-title">Coffee, on time</h1><p>A pitch in four slides</p></section>
<section class="slide" data-pid="s2"><h2>The problem</h2><p>Good beans go stale in the post.</p></section>
<section class="slide" data-pid="s3"><h2>Our fix</h2><p>Roast on Tuesday, ship on Wednesday.</p></section>
<section class="slide" data-pid="s4"><h2>Next</h2><p>Ten founding subscribers.</p></section>
</body></html>`;

/** A small page for a variation: a colored block with a title. */
export const variation = (title: string, color: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:18px system-ui;display:grid;place-items:center;height:100vh;background:${color};color:#fff}</style></head>
<body><h1 data-pid="title">${title}</h1></body></html>`;

let calls = 0;

/**
 * Add one version of a design to a session's artifacts, as `publish` does (a task of its own for each, so a replay
 * finds nothing to match). `group` and `kind` are the bundle fields of the index.
 */
export async function publishDesign(
    app: PocketApp,
    session: ConversationId,
    design: { id: string; title: string; content: string; group?: string; kind?: "page" | "deck" },
): Promise<number> {
    calls += 1;

    return app.harness.commit(async (tx) => {
        const doc = await tx.doc(ArtifactsDoc, session);
        const current = Object.hasOwn(doc.items, design.id) ? doc.items[design.id] : undefined;
        const next = (current?.versions.at(-1)?.version ?? 0) + 1;
        const record = {
            version: next,
            taskId: (7000 + calls) as unknown as TaskId,
            callId: `fixture-${calls}`,
            size: Buffer.byteLength(design.content),
            createdAt: Date.now() - (30 - calls) * 60_000,
        };

        if (current === undefined) {
            // The whole value at once, as `publish` does: the document tracks what is assigned, not what is changed after.
            doc.items[design.id] = {
                title: design.title,
                type: "html",
                versions: [record],
                ...(design.group === undefined ? {} : { group: design.group }),
                ...(design.kind === undefined ? {} : { kind: design.kind }),
            } as ArtifactMeta;
        } else {
            current.title = design.title;
            current.versions.push(record);
        }

        const body = await tx.doc(ArtifactBodyDoc, session, `${design.id}@${next}`, {
            content: design.content,
        });

        body.content = design.content;

        return next;
    }, BACKGROUND_CONTEXT);
}

/** The whole set: `landing` in three versions, the `pitch` deck, and three `hero` variations. */
export async function publishAll(app: PocketApp, session: ConversationId): Promise<void> {
    await publishDesign(app, session, {
        id: "landing",
        title: "Coffee landing page",
        content: landing("Fresh coffee, on time"),
    });
    await publishDesign(app, session, {
        id: "landing",
        title: "Coffee landing page",
        content: landing("Fresh coffee, roasted on Tuesdays"),
    });
    await publishDesign(app, session, {
        id: "landing",
        title: "Coffee landing page",
        content: landing("Fresh coffee, roasted on Tuesdays", "#d6513b"),
    });
    await publishDesign(app, session, {
        id: "pitch",
        title: "Pitch deck",
        content: deck(),
        kind: "deck",
    });

    for (const [id, color] of [
        ["hero-a", "#7a4be0"],
        ["hero-b", "#0e8f6a"],
        ["hero-c", "#c2561d"],
    ] as const) {
        await publishDesign(app, session, {
            id,
            title: `Hero ${id.slice(-1).toUpperCase()}`,
            content: variation(`Hero ${id.slice(-1).toUpperCase()}`, color),
            group: "hero",
        });
    }
}
