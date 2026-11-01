// `changeOf` lives in system.js, which loads with the System view; until then there are no edits to count.
let changer = null;

export function changeWith(change) {
    changer = change;
}

const NONE = { set: [], count: 0 };

export function changeNow(data, history) {
    return !data || history.past.length === 0 || changer === null ? NONE : changer(data, history);
}

export const unsavedOf = (data, history) => changeNow(data, history).count;
