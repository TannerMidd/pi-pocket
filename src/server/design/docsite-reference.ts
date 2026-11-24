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
    const t = ctx.locale.t;
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
    const toolbar = `<div class="toolbar" role="search"><input id="tq" type="search" placeholder="${esc(t("server.design.docsite-reference.reference-section.placeholder.search-names-values", "Search names and values"))}" aria-label="${esc(t("server.design.docsite-reference.reference-section.aria-label.search-table-tokens", "Search the table of tokens"))}" autocomplete="off" spellcheck="false"><select id="tt" aria-label="${esc(t("server.design.docsite-reference.reference-section.aria-label.filter-type", "Filter by type"))}">${option("", "All types")}${types.map((type) => option(type, `${type} (${tokens.filter((token) => token.type === type).length})`)).join("")}</select><select id="tr" aria-label="${esc(t("server.design.docsite-reference.reference-section.aria-label.filter-tier", "Filter by tier"))}">${option("", "All tiers")}${tiers.map((tier) => option(tier, tier)).join("")}</select><span class="desc" id="tc" aria-live="polite">${plural(tokens.length, "token")}</span></div>`;

    return `<p class="intro">${esc(t("server.design.docsite-reference.reference-section.p.every-token-css-variable", "Every token with its CSS variable and its value in each mode. Click a name to copy it."))}</p>${cut}${toolbar}<div class="table-wrap stack" id="token-table"><table><thead><tr><th>${esc(t("server.design.docsite-core.token-table.th.token", "Token"))}</th><th>${esc(t("server.design.docsite-core.token-table.th.type", "Type"))}</th>${ctx.modes.map((mode) => `<th>${esc(modeLabel(mode))}</th>`).join("")}</tr></thead><tbody>${tableRows(ctx, tokens)}</tbody></table></div>`;
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
    const t = ctx.locale.t;
    const { problems, notes = [] } = ctx.system;
    const errors = problems.filter((problem) => problem.level === "error").length;
    // The words of the problem are the validator's, in English; only where it is placed is the page's own text.
    const where = (entry: SystemProblem) =>
        `${entry.file === undefined ? "" : ` ${esc(t("server.design.docsite-reference.problems-html.where.in", "in"))} <code>${esc(entry.file)}</code>`}${entry.token === undefined ? "" : ` ${esc(t("server.design.docsite-reference.problems-html.where.at", "at"))} <code>${esc(entry.token)}</code>`}`;

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
    const t = ctx.locale.t;
    const copy = t("ui.copy", "Copy");
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

    // Every word is escaped where it lands, and a code span stays in the markup: a language never brings markup of its own.
    const darkMode =
        dark === undefined
            ? ""
            : ` ${esc(t("server.design.docsite-reference.code-section.code.set", "Set"))} <code>data-theme="${esc(ctx.slug.get(dark)!)}"</code> ${esc(t("server.design.docsite-reference.code-section.code.on", "on"))} <code>&lt;html&gt;</code> ${esc(t("server.design.docsite-reference.code-section.code.for-mode", "for the {mode} mode.", { mode: modeLabel(dark).toLowerCase() }))}`;

    return `<div class="prose"><p>${esc(t("server.design.docsite-reference.code-section.p.system-writes-files", "The system writes these files to"))} <code>.pi/design/dist/</code>${esc(t("server.design.docsite-reference.code-section.p.never-copy-value", ". Never copy a value by hand:"))}</p><ul><li>${esc(t("server.design.docsite-reference.code-section.li.css-link", "CSS: link"))} <code>tokens.css</code> ${esc(t("server.design.docsite-reference.code-section.code.read-token", "and read a token with"))} <code>var(${esc(sample?.cssVar ?? "--color-bg-surface")})</code>.${darkMode}</li><li>${esc(t("server.design.docsite-reference.code-section.li.tailwind-v4-import", "Tailwind v4: import"))} <code>tailwind.css</code> ${esc(t("server.design.docsite-reference.code-section.code.after-tailwind-utility-reads", "after Tailwind. Each utility reads a token's variable, so it follows the mode."))}</li><li>${esc(t("server.design.docsite-reference.code-section.li.style-dictionary-reads", "Style Dictionary reads a"))} <code>tokens.&lt;mode&gt;.resolved.json</code> ${esc(t("server.design.docsite-reference.code-section.code.file-tokens-studio-loads", "file as it is. Tokens Studio loads"))} <code>tokens.studio.json</code>.</li></ul></div>${files
        .map(([title, note, text]) => {
            const id = `code-${idOf(title!)}`;

            return `<details class="fold"><summary>${esc(title!)} <span class="desc">${esc(note!)}</span></summary>${text!.length > FILE_PREVIEW ? `<p class="sub">${esc(t("server.design.docsite-reference.code-section.p.first-kb", "The first {shown} KB of {total} KB. The whole file is in", { shown: String(FILE_PREVIEW / 1000), total: String(Math.round(text!.length / 1024)) }))} <code>.pi/design/dist/</code>${esc(t("server.design.docsite-reference.code-section.p.zip-export", ", and in the zip that the System view exports."))}</p>` : ""}${snippet(id, clip(text!, FILE_PREVIEW), title!, "", copy)}</details>`;
        })
        .join("")}`;
}
