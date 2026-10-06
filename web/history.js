// What this browser sent from the message box, oldest first, as a shell keeps it: ↑ in the box goes back through it,
// and Ctrl+R searches it. Kept in this browser only, across sessions.

const KEY = "pocket.history";
const MAX = 200;

/** Everything remembered, oldest first. */
export function sentHistory() {
    try {
        const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");

        return Array.isArray(list) ? list.filter((each) => typeof each === "string") : [];
    } catch {
        return [];
    }
}

/** Remember a sent message, as the newest; the same text sent before moves up instead of showing twice. */
export function remember(text) {
    const value = text.trim();

    if (value === "") {
        return;
    }

    const list = sentHistory().filter((each) => each !== value);

    list.push(value);

    try {
        localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
    } catch {
        // Storage is full: the history only stays as it was.
    }
}

/** Sent messages with every word of `query` in them, newest first. */
export function searchHistory(query, limit = 30) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const found = [];
    const list = sentHistory();

    for (let index = list.length - 1; index >= 0 && found.length < limit; index--) {
        const lower = list[index].toLowerCase();

        if (words.every((word) => lower.includes(word))) {
            found.push(list[index]);
        }
    }

    return found;
}
