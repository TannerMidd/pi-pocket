// Every character of the text is escaped before any markup is added, so project text can never become HTML of its own; only `https:` links and `#` anchors keep their address.

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function slugify(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 60) || "section"
    );
}

function safeHref(url: string): string | undefined {
    const text = url.trim();

    if (/^https:\/\/[^\s"'<>]+$/i.test(text) || /^#[\w-]+$/.test(text)) {
        return text;
    }

    return undefined;
}

/** Inline parts: code spans first, so that their text stays literal. */
function inline(text: string): string {
    return text
        .split(/(`[^`]+`)/)
        .map((part) => {
            if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
                return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
            }

            return escapeHtml(part)
                .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, label: string, url: string) => {
                    // The address was escaped with the rest; undo only what an address may hold, then check it.
                    const href = safeHref(url.replace(/&amp;/g, "&"));

                    return href === undefined
                        ? label
                        : `<a href="${escapeHtml(href)}"${href.startsWith("#") ? "" : ' target="_blank" rel="noopener noreferrer"'}>${label}</a>`;
                })
                .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s).,;:])/g, "$1<em>$2</em>");
        })
        .join("");
}

const cells = (line: string) =>
    line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim());

/** The HTML of a Markdown text, bounded to `maxBytes` of input. */
export function renderMarkdown(source: string, maxBytes = 16_384): string {
    const lines = source.slice(0, maxBytes).replace(/\r\n?/g, "\n").split("\n");
    const out: string[] = [];
    let at = 0;

    const startsBlock = (line: string) =>
        /^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+\.\s|---+\s*$|\|)/.test(line);

    while (at < lines.length) {
        const line = lines[at]!;

        if (line.trim() === "") {
            at++;
            continue;
        }

        const fence = /^```\s*([\w+-]*)/.exec(line);

        if (fence !== null) {
            const code: string[] = [];

            at++;

            while (at < lines.length && !lines[at]!.startsWith("```")) {
                code.push(lines[at]!);
                at++;
            }

            at++;
            out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
            continue;
        }

        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);

        if (heading !== null) {
            // The page owns h1 and h2: guideline headings sit below them.
            const level = Math.min(6, heading[1]!.length + 2);

            out.push(
                `<h${level} id="g-${slugify(heading[2]!)}">${inline(heading[2]!)}</h${level}>`,
            );
            at++;
            continue;
        }

        if (/^---+\s*$/.test(line)) {
            out.push("<hr>");
            at++;
            continue;
        }

        if (line.startsWith(">")) {
            const quote: string[] = [];

            while (at < lines.length && lines[at]!.startsWith(">")) {
                quote.push(lines[at]!.replace(/^>\s?/, ""));
                at++;
            }

            out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
            continue;
        }

        if (line.trim().startsWith("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[at + 1] ?? "")) {
            const head = cells(line);

            at += 2;

            const rows: string[][] = [];

            while (at < lines.length && lines[at]!.trim().startsWith("|")) {
                rows.push(cells(lines[at]!));
                at++;
            }

            out.push(
                `<div class="table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows
                    .map(
                        (row) =>
                            `<tr>${head.map((_cell, index) => `<td>${inline(row[index] ?? "")}</td>`).join("")}</tr>`,
                    )
                    .join("")}</tbody></table></div>`,
            );
            continue;
        }

        const list = /^(\s*)([-*+]|\d+\.)\s+/.exec(line);

        if (list !== null) {
            const ordered = /\d/.test(list[2]!);
            const items: string[] = [];

            while (at < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[at]!)) {
                let item = lines[at]!.replace(/^\s*([-*+]|\d+\.)\s+/, "");

                at++;

                while (
                    at < lines.length &&
                    /^\s{2,}\S/.test(lines[at]!) &&
                    !/^\s*([-*+]|\d+\.)\s+/.test(lines[at]!)
                ) {
                    item += ` ${lines[at]!.trim()}`;
                    at++;
                }

                items.push(`<li>${inline(item)}</li>`);
            }

            out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
            continue;
        }

        const paragraph: string[] = [];

        while (
            at < lines.length &&
            lines[at]!.trim() !== "" &&
            (paragraph.length === 0 || !startsBlock(lines[at]!))
        ) {
            paragraph.push(lines[at]!.trim());
            at++;
        }

        out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    }

    return out.join("\n");
}

export function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}
