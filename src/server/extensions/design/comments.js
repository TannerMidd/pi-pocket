// Comments, as the canvas lists them: which are open, which have a pin on the page, and in what order. Pure functions.

/** The comments nobody marked done, oldest first. */
export const openOf = (comments) => comments.filter((comment) => !comment.resolved);

/** The comments with a pin on the page of `version`: open ones made on it. Their order is the pins' numbers. */
export const pinsOf = (comments, version) =>
    openOf(comments).filter((comment) => comment.version === version);

/** A comment's number on the page, or 0 when it has no pin there (done, or made on another version). */
export function pinNumber(comments, comment, version) {
    const at = pinsOf(comments, version).findIndex((each) => each.id === comment.id);

    return at + 1;
}
