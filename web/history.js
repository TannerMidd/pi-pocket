// What this person sent from this browser in one session, oldest first: ↑ recalls it and Ctrl+R searches it.
// Old unscoped strings in pocket.history stay untouched; their sessions cannot be known.

const KEY = "pocket.history.v2";
const MAX = 200;

/** All scoped records, bounded together across people and sessions. */
function readHistory() {
    try {
        const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");

        return Array.isArray(list)
            ? list.filter(
                  (each) =>
                      each &&
                      typeof each.person === "string" &&
                      Number.isSafeInteger(each.conversation) &&
                      typeof each.text === "string",
              )
            : [];
    } catch {
        return [];
    }
}

const inScope = (each, scope) =>
    each.person === scope.person && each.conversation === scope.conversation;

/** This person's remembered text in this session, oldest first. */
export function sentHistory(scope) {
    return readHistory()
        .filter((each) => inScope(each, scope))
        .map((each) => each.text);
}

/** Remember as newest; identical text moves up only within this person's session. */
export function remember(text, scope) {
    const value = text.trim();

    if (value === "" || !scope.person || !Number.isSafeInteger(scope.conversation)) {
        return;
    }

    const list = readHistory().filter((each) => !inScope(each, scope) || each.text !== value);

    list.push({ person: scope.person, conversation: scope.conversation, text: value });

    try {
        localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
    } catch {
        // Storage is full: the history only stays as it was.
    }
}

/** Scoped text with every word of `query` in it, newest first. */
export function searchHistory(query, scope, limit = 30) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const found = [];
    const list = sentHistory(scope);

    for (let index = list.length - 1; index >= 0 && found.length < limit; index--) {
        const lower = list[index].toLowerCase();

        if (words.every((word) => lower.includes(word))) {
            found.push(list[index]);
        }
    }

    return found;
}
