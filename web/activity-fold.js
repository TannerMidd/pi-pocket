// Whether an activity group in the conversation shows its timeline. Appearance's Keep activity folded keeps every group
// on its one line until someone opens it, also while it runs or sits in the newest turn; off, the newest turn's groups
// open as they come. A jump to one of a group's answers opens it as a click does, and a thought alone in its group keeps
// its own rule (its words follow Show thinking). No DOM here, so `test/activity-fold.test.ts` can check it.

/**
 * Whether a group opens, from what it is and what was chosen for it.
 *
 * `chosen` is a click on its line, or a jump to one of its answers (`pocket:reveal`): true opened it, false closed it,
 * undefined leaves it to the rules below. `lone` is the group's only step when that step is a thought, else null.
 * `fold` is Appearance's Keep activity folded.
 */
export function activityOpen({ chosen, lone, live, newest, reading, fold }) {
    // A thought whose words have not come yet (a session opening) stays folded until they have.
    if (lone?.partial === true) {
        return false;
    }

    if (chosen !== undefined) {
        return chosen;
    }

    if (lone) {
        return reading === true && lone.streaming !== true && Boolean(lone.text?.trim());
    }

    return fold === true ? false : live === true || newest === true;
}
