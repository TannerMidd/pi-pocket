// Whether a person just tapped the page or pressed a key. A script cannot make such an event (`isTrusted`), so an action
// that must come from a person can ask for one. This is the rule that the frame of an artifact keeps for its follow-ups
// (`ARTIFACT_BRIDGE` in `src/server/http/artifacts.ts`): a tap serves for 5 seconds, and for one action.

const TAP_MS = 5000;
let tapped = -Infinity;

const tap = (event) => {
    if (event.isTrusted) {
        tapped = performance.now();
    }
};

// One event for each tap: a mouse's press, a finger's or pen's lift, a key's press but not its repeats.
addEventListener("keydown", (event) => event.key !== "Escape" && !event.repeat && tap(event), true);
addEventListener("pointerdown", (event) => event.pointerType === "mouse" && tap(event), true);
addEventListener("pointerup", (event) => event.pointerType !== "mouse" && tap(event), true);

/** True when a person tapped or pressed a key in the last 5 seconds, and not for an action already; uses that tap. */
export function spendTap() {
    const fresh = performance.now() - tapped <= TAP_MS;

    tapped = -Infinity;

    return fresh;
}
