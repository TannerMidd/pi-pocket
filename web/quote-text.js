export const QUOTE_MAX = 1500;

function quoteLines(passage) {
    const text = passage.trim().replace(/\r\n?/g, "\n");
    const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text;

    return cut
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
}

export function withQuote(passage, reply) {
    return passage ? `${quoteLines(passage)}\n\n${reply}`.trimEnd() : reply;
}

export function splitQuote(text) {
    const match = /^((?:>[^\n]*(?:\n|$))+)\n*([\s\S]*)$/.exec(text);

    if (!match) {
        return null;
    }

    const passage = match[1]
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n");

    return { passage, rest: match[2] };
}

/** The text of a selected range, as it was written: math as its TeX, a diagram as "[diagram]". */
export function rangeText(range) {
    const box = document.createElement("div");

    box.style.cssText = "position:fixed;left:-9999px;top:0;width:600px";
    box.append(range.cloneContents());

    for (const each of box.querySelectorAll("[data-tex]")) {
        const mark = each.dataset.lang === "math-display" ? "$$" : "$";

        each.replaceWith(`${mark}${each.dataset.tex}${mark}`);
    }

    for (const each of box.querySelectorAll(".pocket-diagrams-output")) {
        each.replaceWith("[diagram]");
    }

    document.body.append(box);

    const text = box.innerText;

    box.remove();

    return text;
}
