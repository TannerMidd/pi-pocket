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
