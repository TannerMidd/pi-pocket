/**
 * What this computer does for sessions now, for a program that runs the runner (the desktop app's tray, its keep-awake
 * option, and its warning on quit): whether sessions are working here, and in which folders. Only that: no commands,
 * tool names, or sessions.
 *
 * A file or command request of an approved session counts from when the runner sends it to the daemon until its result
 * (`request-gate.ts`). Listing folders for the folder picker, watching files, and network streams for the browser do
 * not count: they say nothing about work, and a page can keep a connection open while nothing runs.
 *
 * Smoothed, so a tray does not flicker: a folder shows once its work lasted `riseMs`, and stays `holdMs` after its last
 * request ended. Quick reads never show; the requests of one turn, one after another, show as one stretch of work.
 */

/** The line a program reads on stdout (`--confirm-via stdio`), followed by the state as JSON. */
export const ACTIVITY_LINE = "PI-POCKET-ACTIVITY";

export type ActivityState = {
    /** Sessions use this computer now. */
    working: boolean;
    /** The real folders of the sessions that use it, sorted; empty when not working. */
    folders: string[];
};

export type ActivityOptions = {
    /** How long work must last before it shows. */
    riseMs?: number;
    /** How long work stays shown after it ended. */
    holdMs?: number;
    now?: () => number;
};

/** One `ACTIVITY_LINE` line. */
export function activityLine(state: ActivityState): string {
    return `${ACTIVITY_LINE} ${JSON.stringify(state)}`;
}

type Use = {
    /** Requests that run now. */
    count: number;
    /** When the current stretch of work began. */
    since: number;
    /** When the last request ended, while none runs. */
    idleAt?: number;
    /** It was reported: it stays `holdMs` after it ends. */
    shown: boolean;
};

export class Activity {
    readonly #onChange: (state: ActivityState) => void;
    readonly #riseMs: number;
    readonly #holdMs: number;
    readonly #now: () => number;
    readonly #folders = new Map<string, Use>();
    #timer: NodeJS.Timeout | undefined;
    #last: string;
    #stopped = false;

    constructor(onChange: (state: ActivityState) => void, options: ActivityOptions = {}) {
        this.#onChange = onChange;
        this.#riseMs = options.riseMs ?? 500;
        this.#holdMs = options.holdMs ?? 5000;
        this.#now = options.now ?? Date.now;
        this.#last = JSON.stringify(this.state());
    }

    /** The state now. */
    state(): ActivityState {
        const now = this.#now();
        const folders = [...this.#folders]
            .filter(([, use]) => this.#visible(use, now))
            .map(([folder]) => folder)
            .sort();

        return { working: folders.length > 0, folders };
    }

    /** A request of a session in `folder` began; call the result when it ended (more than once does nothing). */
    begin(folder: string): () => void {
        const now = this.#now();
        const use = this.#folders.get(folder);

        if (use === undefined) {
            this.#folders.set(folder, { count: 1, since: now, shown: false });
        } else {
            // Work again before the hold ran out: the same stretch goes on.
            if (use.count === 0 && !use.shown) {
                use.since = now;
            }

            use.count++;
            delete use.idleAt;
        }

        this.#update();

        let ended = false;

        return () => {
            if (ended) {
                return;
            }

            ended = true;

            const current = this.#folders.get(folder);

            if (current === undefined) {
                return;
            }

            current.count--;

            if (current.count === 0) {
                current.idleAt = this.#now();
            }

            this.#update();
        };
    }

    /** The runner stopped: idle now, said once if it was working, then no more reports and no timers. */
    stop(): void {
        if (this.#stopped) {
            return;
        }

        this.#folders.clear();
        clearTimeout(this.#timer);
        this.#timer = undefined;

        if (this.#last !== JSON.stringify(this.state())) {
            this.#last = JSON.stringify(this.state());
            this.#onChange(this.state());
        }

        this.#stopped = true;
    }

    #visible(use: Use, now: number): boolean {
        return use.count > 0
            ? now - use.since >= this.#riseMs
            : use.shown && use.idleAt !== undefined && now - use.idleAt < this.#holdMs;
    }

    /** Drop what is over, report a change, and wake for the next one. */
    #update(): void {
        if (this.#stopped) {
            return;
        }

        const now = this.#now();
        let next = Infinity;

        for (const [folder, use] of this.#folders) {
            if (this.#visible(use, now)) {
                use.shown = true;
            }

            if (use.count > 0) {
                if (!use.shown) {
                    next = Math.min(next, use.since + this.#riseMs);
                }
            } else if (!this.#visible(use, now)) {
                this.#folders.delete(folder);
            } else {
                next = Math.min(next, use.idleAt! + this.#holdMs);
            }
        }

        const state = this.state();
        const key = JSON.stringify(state);

        if (key !== this.#last) {
            this.#last = key;
            this.#onChange(state);
        }

        clearTimeout(this.#timer);
        this.#timer = undefined;

        if (next !== Infinity) {
            this.#timer = setTimeout(() => this.#update(), Math.max(0, next - now));
            this.#timer.unref();
        }
    }
}
