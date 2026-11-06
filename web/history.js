// What this person sent from this browser in one session, oldest first: ↑ recalls it and Ctrl+R searches it.
import { HISTORY as KEY, HISTORY_MAX as MAX, personStorage } from "./person-storage.js";

/** All of this person's scoped records, bounded together across sessions. */
function readHistory(person) {
    try {
        const list = JSON.parse(personStorage.get(KEY, person) ?? "[]");

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
    return readHistory(scope.person)
        .filter((each) => inScope(each, scope))
        .map((each) => each.text);
}

/** Remember as newest; identical text moves up only within this person's session. */
export function remember(text, scope) {
    const value = text.trim();

    if (value === "" || !scope.person || !Number.isSafeInteger(scope.conversation)) {
        return;
    }

    const list = readHistory(scope.person).filter(
        (each) => !inScope(each, scope) || each.text !== value,
    );

    list.push({ person: scope.person, conversation: scope.conversation, text: value });

    personStorage.set(KEY, JSON.stringify(list.slice(-MAX)), scope.person);
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
