// The server's clock as a tab knows it: how far it is ahead of this browser's, from the clocks hellos carry. No DOM
// here: `store.js` keeps the offset, and `seen.js` turns the server's times into this device's.

/** How far this browser's clock and its steady one may part during a request before it counts as changed. */
const DRIFT_MS = 1000;

/** A moment, on this browser's clock (`wall`) and on its steady one (`steady`, which no clock change moves). */
export const moment = () => ({ wall: Date.now(), steady: performance.now() });

/**
 * The offset (the server's clock minus this browser's) after a hello whose clock says `now`, from the offset kept so far
 * (undefined before the first). The server read `now` before this tab handled the hello (`handled`), and after this tab
 * asked for it (`asked`), when the hello answers a request of its own: so the offset is at least `now - handled.wall`,
 * and at most `now - asked.wall`. The kept offset moves only as far as those bounds need, and a first one starts between
 * them. A hello handled late (a tab woken from the background, events queued while it slept) only lowers the first
 * bound: it moves nothing, where taking `now - handled.wall` as the offset would move every time shown.
 *
 * The second bound holds only on one clock: when this browser's clock changed during the request, or its steady clock
 * stopped while the device slept, the two clocks part, and the hello counts as one the tab did not ask for.
 */
export function fitClock(kept, now, handled, asked) {
    const least = now - handled.wall;
    const steady =
        asked !== undefined &&
        Math.abs(handled.wall - asked.wall - (handled.steady - asked.steady)) <= DRIFT_MS;
    // The first bound is sure; the second gives way to it if they cross.
    const most = steady ? Math.max(least, now - asked.wall) : Infinity;

    if (kept === undefined) {
        return most === Infinity ? least : (least + most) / 2;
    }

    return Math.min(Math.max(kept, least), most);
}
