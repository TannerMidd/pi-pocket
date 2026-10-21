// The message Pi is writing, put together from view updates. It imports nothing, so the server's tests can run it.

/**
 * The live message after `update`, given the `current` one. An update of protocol 3 is what changed (`LiveMessageDelta`
 * in `projection.ts`); an older one is the whole message. Blocks that did not change stay the same objects, and
 * `current` itself comes back when nothing changed. Null: the update does not fit `current`.
 */
export function liveMessage(current, update) {
    if (update?.keep === undefined) {
        return update;
    }

    const had = current?.blocks ?? [];
    const { keep, blocks: changed } = update;
    const [first, ...rest] = changed;

    if (
        keep > had.length ||
        (first?.from !== undefined &&
            (had[keep]?.type !== first.type || had[keep].text.length !== first.from))
    ) {
        return null;
    }

    if (changed.length === 0 && keep === had.length) {
        return current;
    }

    return {
        blocks:
            first?.from === undefined
                ? [...had.slice(0, keep), ...changed]
                : [
                      ...had.slice(0, keep),
                      { ...had[keep], text: had[keep].text + first.text },
                      ...rest,
                  ],
    };
}
