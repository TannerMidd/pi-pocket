import { snippet } from "./docsite-components.ts";
import { escapeHtml as esc, plural } from "./docsite-markdown.ts";
import {
    type Ctx,
    BASE_GROUNDS,
    clip,
    findToken,
    idOf,
    modeLabel,
    tableRows,
} from "./docsite-core.ts";
import type { SystemProblem } from "./system-types.ts";

export function referenceSection(ctx: Ctx, max: number): string {
    const all = ctx.system.tokens;
    const tokens = all.slice(0, max);
    const cut =
        tokens.length < all.length
            ? `<p class="sub">This table shows the first ${tokens.length} of ${all.length} tokens, to keep the page small. The sections above show the rest.</p>`
            : "";
    const option = (value: string, label: string) =>
        `<option value="${esc(value)}">${esc(label)}</option>`;
    const types = [...new Set(tokens.map((token) => token.type))].sort();
    const tiers = ["primitive", "semantic", "component"].filter((tier) =>
        tokens.some((token) => token.tier === tier),
    );
    const toolbar = `<div class="toolbar" role="search"><input id="tq" type="search" placeholder="Search names and values" aria-label="Search the table of tokens" autocomplete="off" spellcheck="false"><select id="tt" aria-label="Filter by type">${option("", "All types")}${types.map((type) => option(type, `${type} (${tokens.filter((token) => token.type === type).length})`)).join("")}</select><select id="tr" aria-label="Filter by tier">${option("", "All tiers")}${tiers.map((tier) => option(tier, tier)).join("")}</select><span class="desc" id="tc" aria-live="polite">${plural(tokens.length, "token")}</span></div>`;

    return `<p class="intro">Every token with its CSS variable and its value in each mode. Click a name to copy it.</p>${cut}${toolbar}<div class="table-wrap stack" id="token-table"><table><thead><tr><th>Token</th><th>Type</th>${ctx.modes.map((mode) => `<th>${esc(modeLabel(mode))}</th>`).join("")}</tr></thead><tbody>${tableRows(ctx, tokens)}</tbody></table></div>`;
}

function findings(summary: string, list: SystemProblem[], item: (entry: SystemProblem) => string) {
    return list.length === 0
        ? ""
        : `<details class="notes"><summary>${summary}</summary><ul>${list
              .slice(0, 50)
              .map((entry) => `<li>${item(entry)}</li>`)
              .join("")}</ul></details>`;
}

export function problemsHtml(ctx: Ctx): string {
    const { problems, notes = [] } = ctx.system;
    const errors = problems.filter((problem) => problem.level === "error").length;
    const where = (entry: SystemProblem) =>
        `${entry.file === undefined ? "" : ` in <code>${esc(entry.file)}</code>`}${entry.token === undefined ? "" : ` at <code>${esc(entry.token)}</code>`}`;

    return (
        findings(
            `${errors > 0 ? `${plural(errors, "error")} and ` : ""}${plural(problems.length - errors, "warning")} from the validator`,
            problems,
            (entry) =>
                `<strong>${entry.level === "error" ? "Error" : "Warning"}</strong>${where(entry)}: ${esc(clip(entry.message, 300))}`,
        ) +
        findings(
            `${plural(notes.length, "note")} from the validator`,
            notes,
            (entry) =>
                `${where(entry).trim()}${where(entry) === "" ? "" : ": "}${esc(clip(entry.message, 300))}`,
        )
    );
}

/** The most of a generated file that the page prints: the files are large, and the page is one file too. */
const FILE_PREVIEW = 3_000;

export function codeSection(ctx: Ctx): string {
    const { compiled } = ctx.system;
    const sample =
        findToken(ctx, BASE_GROUNDS) ??
        ctx.system.tokens.find((token) => token.type === "color" && token.tier === "semantic") ??
        ctx.system.tokens[0];
    const dark = ctx.modes.find((mode) => ctx.theme.get(mode) === "dark" && mode !== ctx.modes[0]);
    const files = [
        [
            "README.md",
            "What each file is, and how to use it.",
            (compiled as { readme?: string }).readme ?? "",
        ],
        ["tokens.css", "Variables for every mode. Link it from every page.", compiled.css],
        [
            "tailwind.css",
            "A Tailwind v4 @theme block, one variable for each token.",
            compiled.tailwind,
        ],
        [
            "names.md",
            "Every token with its variable in tokens.css and in tailwind.css, and its Tailwind utilities.",
            compiled.names ?? "",
        ],
        ...Object.entries(compiled.modes ?? {}).map(([mode, text]) => [
            `tokens.${mode}.resolved.json`,
            `The ${modeLabel(mode).toLowerCase()} mode as a DTCG file, for Style Dictionary and other tools.`,
            text,
        ]),
        [
            "tokens.studio.json",
            "For Tokens Studio: a token set for each mode, and a $themes array.",
            compiled.studio ?? "",
        ],
        ["tokens.resolved.json", "A compact summary for scripts.", compiled.json],
        ["components.css", "The CSS of every component.", compiled.components],
    ].filter(([, , text]) => text!.trim() !== "");

    return `<div class="prose"><p>The system writes these files to <code>.pi/design/dist/</code>. Never copy a value by hand:</p><ul><li>CSS: link <code>tokens.css</code> and read a token with <code>var(${esc(sample?.cssVar ?? "--color-bg-surface")})</code>.${dark === undefined ? "" : ` Set <code>data-theme="${esc(ctx.slug.get(dark)!)}"</code> on <code>&lt;html&gt;</code> for the ${esc(modeLabel(dark).toLowerCase())} mode.`}</li><li>Tailwind v4: import <code>tailwind.css</code> after Tailwind. Each utility reads a token's variable, so it follows the mode.</li><li>Style Dictionary reads a <code>tokens.&lt;mode&gt;.resolved.json</code> file as it is. Tokens Studio loads <code>tokens.studio.json</code>.</li></ul></div>${files
        .map(([title, note, text]) => {
            const id = `code-${idOf(title!)}`;

            return `<details class="fold"><summary>${esc(title!)} <span class="desc">${esc(note!)}</span></summary>${text!.length > FILE_PREVIEW ? `<p class="sub">The first ${FILE_PREVIEW / 1000} KB of ${Math.round(text!.length / 1024)} KB. The whole file is in <code>.pi/design/dist/</code>, and in the zip that the System view exports.</p>` : ""}${snippet(id, clip(text!, FILE_PREVIEW), title!)}</details>`;
        })
        .join("")}`;
}
