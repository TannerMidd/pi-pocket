// Pi Pocket's docs, read where they are in the repository, with no copies: docs/**/*.md (not docs/design/),
// SECURITY.md, and CONTRIBUTING.md. Pi reads the same files, and GitHub shows them, so they stay plain Markdown
// without front matter.
//
// - `repoDocsLoader` is Astro's glob loader on the repository root. A page's title is its `# H1`, its description
//   its first paragraph. Each build also checks every relative link and anchor of every page (`checkLinks`), and
//   that the reference says what types/pocket.d.ts says (`checkReference`), and that docs/ has no links in it. It fails
//   with the whole list.
// - `repoMarkdown` is a Sätteri mdast plugin for the pages: it drops the H1 (Starlight draws the title), rewrites
//   relative links (a page to its address on the site, anything else to GitHub), and draws a reference member's
//   "Since 0.14.0 · Stable" line as two tags.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import { glob } from "astro/loaders";
import { markdownToMdast } from "satteri";
import { checkReference } from "./reference-check.mjs";
import { MOVED } from "./sidebar.mjs";

export const REPO = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const GITHUB = "https://github.com/TannerMidd/pi-pocket";
export const BASE = "/pi-pocket/docs";

/** The commit code links point at: DOCS_REF, or this checkout's. */
export const REF =
    process.env.DOCS_REF ??
    (() => {
        try {
            return execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: REPO,
                encoding: "utf8",
            }).trim();
        } catch {
            return "main";
        }
    })();

/** Pi Pocket's version, as the footer says it. */
export const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

const ROOT_PAGES = ["SECURITY.md", "CONTRIBUTING.md"];

/**
 * Folders of docs/ that the site does not publish: Design mode's notes, and the example design system (a project's
 * `.pi/design/` folder, with its generated files), which goes with them.
 */
const UNPUBLISHED = ["docs/design/", "docs/examples/design-system/"];

/** Whether a repository path is a page of the site (it may not exist yet). */
export function isPagePath(repoPath) {
    return (
        ROOT_PAGES.includes(repoPath) ||
        (repoPath.startsWith("docs/") &&
            repoPath.endsWith(".md") &&
            !UNPUBLISHED.some((folder) => repoPath.startsWith(folder)))
    );
}

/** A page's id, which is its address under BASE: docs/a/b.md is a/b, docs/a/index.md is a. */
export function idOf(repoPath) {
    if (repoPath === "docs/index.md") {
        return "start";
    }

    if (ROOT_PAGES.includes(repoPath)) {
        return repoPath.replace(/\.md$/, "").toLowerCase();
    }

    return repoPath
        .replace(/^docs\//, "")
        .replace(/(^|\/)index\.md$/, "")
        .replace(/\.md$/, "")
        .toLowerCase();
}

export const urlOf = (repoPath) => `${BASE}/${idOf(repoPath)}/`;

/** Every page there is, as repository paths. */
export function pages() {
    const found = ROOT_PAGES.filter((file) => existsSync(join(REPO, file)));

    const walk = (folder) => {
        for (const entry of readdirSync(join(REPO, folder), { withFileTypes: true })) {
            const path = `${folder}/${entry.name}`;

            if (entry.isDirectory() && !UNPUBLISHED.includes(`${path}/`)) {
                walk(path);
            } else if (entry.isFile() && isPagePath(path)) {
                found.push(path);
            }
        }
    };

    walk("docs");

    return found.sort();
}

/**
 * Each link in docs/, and a root page that is a link. The build reads what docs/ holds and publishes it, so a link
 * there could put a file of the machine that builds it (a runner's secrets) on the site: a pull request must not.
 */
export function links() {
    const found = ROOT_PAGES.filter(
        (file) => existsSync(join(REPO, file)) && lstatSync(join(REPO, file)).isSymbolicLink(),
    );

    const walk = (folder) => {
        for (const entry of readdirSync(join(REPO, folder), { withFileTypes: true })) {
            const path = `${folder}/${entry.name}`;

            if (entry.isSymbolicLink()) {
                found.push(path);
            } else if (entry.isDirectory()) {
                walk(path);
            }
        }
    };

    walk("docs");

    return found;
}

/** The text of an mdast node, as a heading's anchor is made from it. */
function textOf(node) {
    if (node.type === "text" || node.type === "inlineCode") {
        return node.value;
    }

    return (node.children ?? []).map(textOf).join("");
}

const parsed = new Map();

function parse(repoPath) {
    const source = readFileSync(join(REPO, repoPath), "utf8");
    const cached = parsed.get(repoPath);

    if (cached?.source === source) {
        return cached;
    }

    const tree = markdownToMdast(source, { features: { gfm: true } });
    const slugger = new GithubSlugger();
    const headings = [];
    const links = [];
    const code = [];

    const visit = (node) => {
        if (node.type === "heading") {
            headings.push({
                depth: node.depth,
                text: textOf(node),
                slug: slugger.slug(textOf(node)),
            });
        }

        if (node.type === "link" || node.type === "definition" || node.type === "image") {
            links.push({ url: node.url, line: node.position?.start.line });
        }

        if (node.type === "code" && typeof node.meta === "string") {
            const title = /title="([^"]+)"/.exec(node.meta)?.[1];

            if (title !== undefined) {
                code.push({ title, value: node.value, line: node.position?.start.line });
            }
        }

        for (const child of node.children ?? []) {
            visit(child);
        }
    };

    visit(tree);

    const paragraph = tree.children.find((node) => node.type === "paragraph");
    const page = {
        source,
        title: headings.find((heading) => heading.depth === 1)?.text,
        description: paragraph === undefined ? undefined : textOf(paragraph).replace(/\s+/g, " "),
        anchors: new Set(headings.map((heading) => heading.slug)),
        headings,
        links,
        code,
    };

    parsed.set(repoPath, page);

    return page;
}

function shorten(text) {
    if (text === undefined || text.length <= 160) {
        return text;
    }

    return `${text.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}

/** Where a relative link in `from` leads in the repository, and its anchor; undefined for other links. */
function target(from, url) {
    if (url === "" || url.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(url)) {
        return undefined;
    }

    const at = url.indexOf("#");
    const path = at === -1 ? url : url.slice(0, at);
    const hash = at === -1 ? "" : url.slice(at);

    if (path === "") {
        return { path: from, hash, own: true };
    }

    return { path: posix.normalize(posix.join(posix.dirname(from), path)), hash, own: false };
}

/** A link in `from` as the site writes it. */
export function rewrite(from, url) {
    const to = target(from, url);

    if (to === undefined || to.own) {
        return url;
    }

    const path = to.path.replace(/\/$/, "");

    if (isPagePath(path) && existsSync(join(REPO, path))) {
        return `${urlOf(path)}${to.hash}`;
    }

    const full = join(REPO, path);
    const kind = existsSync(full) && statSync(full).isDirectory() ? "tree" : "blob";

    return `${GITHUB}/${kind}/${REF}/${path}${to.hash}`;
}

const withoutTypeImports = (text) =>
    text
        .split("\n")
        .filter((line) => !line.startsWith("import type "))
        .join("\n")
        .trim();

/**
 * Every problem with the pages' links and headings: a link to a file that is not in the repository, or to an
 * anchor that is not there (as GitHub makes anchors, and the site the same way), a page without one `# H1` at its
 * top, a heading that repeats the H1 (GitHub would give it another anchor than the site does), or a code block that
 * shows an example as it no longer is.
 */
export function checkLinks() {
    const errors = [];

    for (const from of pages()) {
        const page = parse(from);
        const h1 = page.headings.filter((heading) => heading.depth === 1);

        if (h1.length !== 1 || page.headings[0]?.depth !== 1) {
            errors.push(`${from}: a page needs one "# Title" as its first heading`);
        } else if (
            page.headings.some((heading) => heading.depth > 1 && heading.slug === h1[0].slug)
        ) {
            errors.push(`${from}: a heading repeats the title "${h1[0].text}"`);
        }

        // A code block titled after an example (title="my-words.ts") shows that example, which the tests run: it must
        // say what the file says, but for its `import type` lines, which differ where the file lies.
        for (const { title, value, line } of page.code) {
            const example = join(REPO, "docs/examples", title);

            if (
                existsSync(example) &&
                withoutTypeImports(value) !== withoutTypeImports(readFileSync(example, "utf8"))
            ) {
                errors.push(
                    `${from}:${line ?? "?"}: the code titled ${title} differs from docs/examples/${title}`,
                );
            }
        }

        for (const { url, line } of page.links) {
            const to = target(from, url);

            if (to === undefined) {
                continue;
            }

            const where = `${from}:${line ?? "?"}`;
            const path = to.path.replace(/\/$/, "");

            if (path.startsWith("..")) {
                errors.push(`${where}: "${url}" leads out of the repository`);
                continue;
            }

            if (!existsSync(join(REPO, path))) {
                errors.push(`${where}: "${url}" leads to ${path}, which is not in the repository`);
                continue;
            }

            if (
                to.hash !== "" &&
                path.endsWith(".md") &&
                !parse(path).anchors.has(to.hash.slice(1))
            ) {
                const moved = MOVED[`${path}${to.hash}`];

                errors.push(
                    `${where}: "${url}" leads to no heading in ${path}` +
                        (moved === undefined ? "" : ` (it moved to ${moved})`),
                );
            }
        }
    }

    return errors;
}

export function repoDocsLoader() {
    const inner = glob({
        base: REPO,
        pattern: ["docs/**/*.md", "!docs/design/**", ...ROOT_PAGES],
        generateId: ({ entry }) => idOf(entry),
    });

    return {
        name: "pi-pocket-docs",
        load: async (context) => {
            const errors = checkLinks();

            errors.unshift(
                ...links().map(
                    (path) =>
                        `${path} is a link: the docs take no links, so none can publish a file from elsewhere`,
                ),
            );

            errors.push(...checkReference(REPO));

            if (errors.length > 0) {
                throw new Error(`The docs have broken links or headings:\n${errors.join("\n")}`);
            }

            await inner.load({
                ...context,
                parseData: async (options) => {
                    const repoPath = relative(REPO, resolve(options.filePath ?? "")).replaceAll(
                        "\\",
                        "/",
                    );
                    const page = parse(repoPath);

                    return context.parseData({
                        ...options,
                        data: {
                            title: page.title ?? repoPath,
                            description: shorten(page.description),
                            editUrl: `${GITHUB}/edit/main/${repoPath}`,
                            ...options.data,
                        },
                    });
                },
            });
        },
    };
}

const META = /^Since (\d+\.\d+\.\d+) · (Stable|Experimental|Deprecated)\b(.*)$/;

/** The Sätteri plugin for the pages: one instance per file, so it knows where its relative links start. */
export function repoMarkdown({ fileURL }) {
    if (fileURL === undefined) {
        return undefined;
    }

    const from = relative(REPO, fileURLToPath(fileURL)).replaceAll("\\", "/");

    if (!isPagePath(from)) {
        return undefined;
    }

    let titled = false;

    const relink = (node, ctx) => {
        const url = rewrite(from, node.url);

        if (url !== node.url) {
            ctx.setProperty(node, "url", url);
        }
    };

    return {
        name: "pi-pocket-docs",
        heading(node, ctx) {
            if (!titled && node.depth === 1) {
                titled = true;
                ctx.removeNode(node);
            }
        },
        link: relink,
        definition: relink,
        // "Since 0.14.0 · Stable" under a reference member: plain text on GitHub and for Pi, two tags here.
        paragraph(node, ctx) {
            const first = node.children[0];
            const meta = first?.type === "text" ? META.exec(first.value) : null;

            if (meta === null) {
                return;
            }

            const tag = (text, kind) => ({
                type: "emphasis",
                data: { hName: "span", hProperties: { className: ["tag", kind] } },
                children: [{ type: "text", value: text }],
            });

            ctx.replaceNode(node, {
                type: "paragraph",
                data: { hName: "p", hProperties: { className: ["member-meta"] } },
                children: [
                    tag(`Since ${meta[1]}`, "since"),
                    tag(meta[2], meta[2].toLowerCase()),
                    ...(meta[3] === "" ? [] : [{ type: "text", value: meta[3] }]),
                    ...node.children.slice(1),
                ],
            });
        },
    };
}
