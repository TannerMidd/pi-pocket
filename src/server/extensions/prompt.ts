/**
 * The system prompt: who the agent is, how to behave on a phone-sized screen, where Pi Pocket's documentation is, the
 * project's AGENTS.md files, Pi's skills, and the working directory. Sections render before every request; only
 * changed sections are sent again, so everything here is stable between requests unless a file on disk changed.
 *
 * Edit freely: saving this file reloads it into the running server.
 */
import { statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getDocsPath, loadProjectContextFiles, type Skill } from "@earendil-works/pi-coding-agent";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { APP_ROOT } from "../config.ts";
import type { PocketHost } from "../host.ts";

const PREAMBLE = `You are Pi, a coding agent running inside Pi Pocket: a durable, multiplayer web app built on Pi Durable. People talk to you from a browser, often a phone, and several people can share one conversation. When more than one person uses this server, each message starts with [from: Name].

You work in the conversation's working directory with the tools you are given. Your work is durable: if the server restarts, you continue where you left off. A tool call cut off by a restart comes back as an "interrupted" error when it was not safe to repeat; check what actually happened before you retry it.`;

const GUIDELINES = `- Keep replies short and easy to read on a small screen. Lead with the answer; use short paragraphs, lists, and small code blocks.
- Use read to look at files instead of cat or sed. Use edit for precise changes and write for new files or full rewrites.
- Show file paths clearly when you work with files.
- To show an image file from this machine, embed it: ![short description](/absolute/or/relative/path.png). Files the user attaches are saved on the server; the message lists their paths.
- Before running something destructive or irreversible, say what it will do. A guard may ask a human to approve risky commands; if a call is blocked, do not try to get around the block.
- A message with the marker "[via PiP]" or "[via linked session …]" at its start (after any "[from: Name]" or "[scheduled]") comes from another agent. Write your answer to it, and what you send back to that agent, in ASD-STE100 (Simplified Technical English) at about 80% adherence: short sentences (25 words or fewer), one idea each, main point first, active voice, simple tenses, articles kept, no contractions or idioms, "must" for a rule and "can" for an ability, numerals, one word for one thing, names of commands, files, and identifiers exact in backticks, every fact kept. Answer messages without the marker as usual, also later in the same session.`;

/**
 * Where Pi Pocket's documentation for agents is, as Pi's prompt says where Pi's is: to read only when it is
 * needed.
 */
function docs(dataDir: string): string {
    const code = resolve(APP_ROOT);
    const folder = join(code, "docs");

    return `Pi Pocket's docs, only for questions about Pi Pocket itself (how it works, changing how you behave in it, extending it, changing its code): start at ${join(folder, "index.md")}, an index (follow only the links your task needs), and read a doc completely before changing anything.
- Code: ${code}${code.split(sep).includes("node_modules") ? " (an npm install: read it, never edit it, since the next npm update replaces it; to change Pi Pocket, clone https://github.com/TannerMidd/pi-pocket and run that)" : ""}. Data: ${dataDir}; change it through the app, never by editing its files, except extensions/ (drop-ins) and themes/.
- Pi's own docs (skills, prompt templates, models, providers, settings): ${getDocsPath()}`;
}

/** Pi's own format (XML, a location per skill) costs about 150 characters more for each skill. */
export function formatSkills(skills: readonly Skill[]): string {
    const visible = skills.filter((skill) => !skill.disableModelInvocation);

    if (visible.length === 0) {
        return "";
    }

    // A description cannot close the block early.
    const oneLine = (text: string) =>
        text.replace(/\s+/g, " ").replaceAll("</skills", "&lt;/skills").trim();
    const groups = new Map<string, string[]>();
    const others: string[] = [];

    for (const skill of visible) {
        const folder = dirname(dirname(skill.filePath));
        const usual =
            basename(skill.filePath) === "SKILL.md" &&
            basename(dirname(skill.filePath)) === skill.name;

        if (usual) {
            groups.set(folder, [
                ...(groups.get(folder) ?? []),
                `- ${skill.name}: ${oneLine(skill.description)}`,
            ]);
        } else {
            others.push(`- ${skill.name} (${skill.filePath}): ${oneLine(skill.description)}`);
        }
    }

    const blocks = [...groups].map(
        ([folder, lines]) => `In ${join(folder, "<name>", "SKILL.md")}:\n${lines.join("\n")}`,
    );

    if (others.length > 0) {
        blocks.push(`At their own paths:\n${others.join("\n")}`);
    }

    return `<skills>\nWhen a task matches a skill's description, read its SKILL.md with the read tool and follow it. Resolve a relative path in it against the skill's folder.\n\n${blocks.join("\n\n")}\n</skills>`;
}

const STALE_MS = 30_000;

type Resources = {
    at: number;
    trust: number;
    context: string | undefined;
    skills: string | undefined;
};

export default function createPrompt(host: PocketHost) {
    // Context files and skills load once per directory, and again when the copy is older than STALE_MS, or Pi's trust
    // store changed since: a project trusted now has skills it did not have, from the next request on. Only answers to
    // "trust this project?" show at once; other changes (a new skill, Pi's defaultProjectTrust) wait for STALE_MS, or
    // a request more (the app reads Pi's settings again in the background as often).
    const resources = new Map<string, Resources>();

    const trustChanged = () => {
        try {
            return statSync(join(host.agentDir, "trust.json")).mtimeMs;
        } catch {
            return 0;
        }
    };

    const load = (cwd: string): Resources => {
        const cached = resources.get(cwd);
        const trust = trustChanged();

        if (cached !== undefined && Date.now() - cached.at < STALE_MS && cached.trust === trust) {
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
            const text = formatSkills(host.skills(cwd));

            skills = text === "" ? undefined : text;
        } catch (error) {
            host.notice("warning", `Could not load skills for ${cwd}: ${String(error)}`);
        }

        const fresh = { at: Date.now(), trust, context, skills };

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
                const base = `Working directory: ${cwdOf(input)}\nPlatform: ${process.platform}`;

                // Off by default: a date in the system prompt changes once a day and rewrites the whole prompt cache.
                // PI_POCKET_PROMPT_DATE=1 adds the local date back.
                if (process.env.PI_POCKET_PROMPT_DATE !== "1") {
                    return base;
                }

                const now = new Date();
                const pad = (n: number) => String(n).padStart(2, "0");

                return `${base}\nToday: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            }),
        ],
    });
}
