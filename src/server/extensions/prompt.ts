/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pi Pocket's documentation is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { join, resolve } from "node:path";
import {
    formatSkillsForPrompt,
    getDocsPath,
    loadProjectContextFiles,
    loadSkills,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";

const PREAMBLE = `You are Pi, a coding agent running inside Pi Pocket: a durable, multiplayer web app built on Pi Durable. People talk to you from a browser, often a phone, and several people can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory with the tools you are given. Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show the user an image file from this machine (a screenshot, a chart, a picture), embed it in your reply with Markdown: ![short description](/absolute/path.png). Paths relative to the working directory work too. Files the user attaches are saved on the server; their paths are listed in the message.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- Do not commit, push, publish, or deploy unless asked.`;

/**
 * Where Pi Pocket's documentation for agents is, as Pi's prompt says where Pi's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    return `Pi Pocket documentation (read only when someone asks about Pi Pocket itself: how it works, changing how you behave in it, extending it, or changing its code):
- Start here: ${join(folder, "index.md")}
- Pi Pocket's code is in ${code}; its data (people, settings, sessions) in ${dataDir}. Change the data through the app, never by editing its files, except extensions/ in it, where drop-in extensions go.
- When asked about: changing how you behave without code, such as instructions, AGENTS.md, skills, or prompt templates (docs/customizing.md); a new tool, prompt section, or hook (docs/extensions.md, with working examples in docs/examples/); changing Pi Pocket's own code while it runs (docs/self-editing.md); where its code is (docs/map.md); how its parts depend on each other (docs/architecture.md); what a feature does (docs/features.md)
- Resolve docs/... under ${code}, not the working directory. Read a doc completely, and follow its links, before changing anything.
- Pi's own documentation (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

const STALE_MS = 30_000;

type Resources = { at: number; context: string | undefined; skills: string | undefined };

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS.
    const resources = new Map<string, Resources>();

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);

        if (cached !== undefined && Date.now() - cached.at < STALE_MS) {
            return cached;
        }

        let context: string | undefined;
        let skills: string | undefined;

        try {
            const files = loadProjectContextFiles({ cwd, agentDir: host.agentDir });

            if (files.length > 0) {
                context = files
                    .map((file) => `<file path="${file.path}">\n${file.content.trim()}\n</file>`)
                    .join("\n\n");
            }
        } catch (error) {
            host.notice("warning", `Could not load AGENTS.md files for ${cwd}: ${String(error)}`);
        }

        try {
            const loaded = loadSkills({
                cwd,
                agentDir: host.agentDir,
                skillPaths: host.skillPaths(),
                includeDefaults: true,
            });
            const text = formatSkillsForPrompt(loaded.skills, "read").trim();

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), context, skills };

        resources.set(cwd, fresh);

        return fresh;
    };

    const cwdOf = (input: PromptInput) => input.env?.cwd ?? input.agent.cwd ?? process.cwd();

    return defineExtension({
        name: "pocket-prompt",
        sections: [
            section("preamble", () => PREAMBLE, { tag: false }),
            section("guidelines", () => GUIDELINES),
            section("pocket_docs", () => docs(host.dataDir)),
            section("project_context", (input) => load(cwdOf(input)).context),
            section("skills", (input) => load(cwdOf(input)).skills, { tag: false }),
            section("environment", (input) => {
                // The date only, so the prompt stays cache-friendly through the day.
                const today = new Date().toISOString().slice(0, 10);

                return `Working directory: ${cwdOf(input)}\nPlatform: ${process.platform}\nToday: ${today}`;
            }),
        ],
    });
}
