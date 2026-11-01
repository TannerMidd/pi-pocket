/** What Find searches in a user row: its label and summary, then the text that was written. */
export function userSearchText(presentation, written) {
    return [presentation?.label, presentation?.summary, written]
        .filter((part) => typeof part === "string" && part !== "")
        .join("\n");
}
