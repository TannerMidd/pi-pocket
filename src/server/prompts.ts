/**
 * Pi's prompt templates as slash commands: `/review src/auth.ts` sends the `review.md` template with its arguments
 * filled in. Templates load the way Pi loads them: `prompts/` in Pi's folder, then `.pi/prompts/` in the session's
 * folder, then the paths in Pi's settings; the first with a name wins. Each is a Markdown file whose name is the
 * command, with an optional `description` and `argument-hint` in its front matter.
 *
 * This follows `dist/core/prompt-templates.js` in @earendil-works/pi-coding-agent, which the package does not export:
 * check it against that file when updating Pi.
 *
 * Skills are commands too, as `/skill:name [what to do]`: the skill's instructions go to Pi with the request, as
 * `_expandSkillCommand` in `dist/core/agent-session.js` writes them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./paths.ts";

export type PromptTemplate = {
    name: string;
    description: string;
    argumentHint?: string;
    content: string;
    path: string;
};

/** How much of a template's first line serves as its description, when it has none. */
const DESCRIPTION_LENGTH = 60;

function readTemplate(path: string): PromptTemplate | undefined {
    let frontmatter: Record<string, unknown>;
    let body: string;

    try {
        ({ frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8")) as {
            frontmatter: Record<string, unknown>;
            body: string;
        });
    } catch {
        return undefined;
    }

    let description = typeof frontmatter.description === "string" ? frontmatter.description : "";

    if (description === "") {
        const first = body.split("\n").find((line) => line.trim() !== "") ?? "";

        description =
            first.length > DESCRIPTION_LENGTH ? `${first.slice(0, DESCRIPTION_LENGTH)}...` : first;
    }

    const hint = frontmatter["argument-hint"];

    return {
        name: basename(path).replace(/\.md$/, ""),
        description,
        ...(typeof hint === "string" ? { argumentHint: hint } : {}),
        content: body,
        path,
    };
}

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/** The `.md` files of a folder, not its subfolders; a missing or unreadable folder has none. */
function templatesIn(directory: string): PromptTemplate[] {
    let names: string[];

    try {
        names = readdirSync(directory)
            .filter((name) => name.endsWith(".md"))
            .sort();
    } catch {
        return [];
    }

    return names.flatMap((name) => {
        const path = join(directory, name);
        const template = isFile(path) ? readTemplate(path) : undefined;

        return template === undefined ? [] : [template];
    });
}

/** The templates a session in `cwd` offers, first of each name only. `paths` are Pi's configured extra ones. */
export function loadPromptTemplates(
    cwd: string,
    agentDir: string,
    paths: readonly string[],
): PromptTemplate[] {
    const found = [
        ...templatesIn(join(agentDir, "prompts")),
        ...templatesIn(resolve(cwd, CONFIG_DIR_NAME, "prompts")),
    ];

    for (const raw of paths) {
        const path = resolve(cwd, expandHome(raw.trim()));

        if (!existsSync(path)) {
            continue;
        }

        if (isFile(path)) {
            const template = path.endsWith(".md") ? readTemplate(path) : undefined;

            if (template !== undefined) {
                found.push(template);
            }
        } else {
            found.push(...templatesIn(path));
        }
    }

    return found.filter(
        (template, index) => found.findIndex((other) => other.name === template.name) === index,
    );
}

/** Arguments as a shell would split them: at spaces, except inside single or double quotes. */
export function parseArguments(text: string): string[] {
    const args: string[] = [];
    let current = "";
    let quote: string | undefined;

    for (const char of text) {
        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (/\s/.test(char)) {
            if (current !== "") {
                args.push(current);
            }

            current = "";
        } else {
            current += char;
        }
    }

    if (current !== "") {
        args.push(current);
    }

    return args;
}

/**
 * Fill a template's placeholders: `$1`, `$2`… for one argument, `$@` and `$ARGUMENTS` for all, `${N:-default}` and
 * `${@:-default}` with a default for a missing one, and `${@:N}` or `${@:N:L}` for the arguments from the Nth (L of
 * them). Values are not filled in again, so an argument that contains `$1` stays as written.
 */
export function fillTemplate(content: string, args: readonly string[]): string {
    const all = args.join(" ");

    return content.replace(
        /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
        (
            _match,
            withDefault: string | undefined,
            fallback: string | undefined,
            from: string | undefined,
            count: string | undefined,
            plain: string | undefined,
        ) => {
            if (withDefault !== undefined) {
                const value =
                    withDefault === "@" || withDefault === "ARGUMENTS"
                        ? all
                        : args[Number(withDefault) - 1];

                return value === undefined || value === "" ? (fallback ?? "") : value;
            }

            if (from !== undefined) {
                const start = Math.max(0, Number(from) - 1);

                return (
                    count === undefined
                        ? args.slice(start)
                        : args.slice(start, start + Number(count))
                ).join(" ");
            }

            if (plain === "@" || plain === "ARGUMENTS") {
                return all;
            }

            return args[Number(plain) - 1] ?? "";
        },
    );
}

/** `/name arguments` filled in from the template of that name; undefined when the text is not one. */
export function expandPromptTemplate(
    text: string,
    templates: readonly PromptTemplate[],
): string | undefined {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);

    if (match === null) {
        return undefined;
    }

    const template = templates.find((each) => each.name === match[1]);

    return template === undefined
        ? undefined
        : fillTemplate(template.content, parseArguments(match[2] ?? ""));
}

/** A skill Pi has in a session's folder (`skills.ts` finds them), to run as `/skill:name`. */
export type SkillCommand = { name: string; description: string; path: string; baseDir: string };

/** `/skill:name request` with the skill's instructions, as Pi sends it; undefined when the text is not one. */
export function expandSkillCommand(
    text: string,
    skills: readonly SkillCommand[],
): string | undefined {
    const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    const skill = match === null ? undefined : skills.find((each) => each.name === match[1]);

    if (skill === undefined) {
        return undefined;
    }

    let body: string;

    try {
        body = (parseFrontmatter(readFileSync(skill.path, "utf8")) as { body: string }).body.trim();
    } catch {
        return undefined;
    }

    const block = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    const request = (match![2] ?? "").trim();

    return request === "" ? block : `${block}\n\n${request}`;
}
