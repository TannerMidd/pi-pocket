// Browser-local content belongs to a person, never to the next account that uses this browser.
const PREFIX = "pocket.person.";

/** What `history.js` keeps for a person, and how many records. */
export const HISTORY = "history";
export const HISTORY_MAX = 200;
/** The records of every person that 0.27 kept together: each one names its person. */
const OLD_HISTORY = "pocket.history.v2";
// Old versions did not know whose drafts these were. Do not assign them to whoever signs in next.
const legacy = (key) =>
    /^(pocket\.(draft\.|pastes\.|attached\.|viewed\.|history(?:$|\.)|pip\.draft$))/.test(key);

/** A blocked/full store keeps changes in memory, including deletions that would otherwise reveal an older value. */
export function createPersonStorage(storage = () => localStorage) {
    let person = null;
    let locked = true;
    const pending = new Map();
    const scoped = (key, account) =>
        !locked && account && account === person
            ? `${PREFIX}${encodeURIComponent(account)}:${key}`
            : null;

    const removeMatching = (matches) => {
        try {
            const disk = storage();
            const keys = [];

            for (let index = 0; index < disk.length; index++) {
                const key = disk.key(index);

                if (key !== null && matches(key)) {
                    keys.push(key);
                }
            }

            for (const key of keys) {
                disk.removeItem(key);
            }
        } catch {
            // Storage can be denied. Unscoped keys are never read, even if the browser refuses to remove them.
        }
    };

    /**
     * Move the sent text that 0.27 kept for `account` to its own key, before the old ones, and leave other people's to
     * them: it is theirs when they sign in. Nothing moves if the new key cannot be written.
     */
    const moveOldHistory = (account) => {
        try {
            const disk = storage();
            let old;

            try {
                old = JSON.parse(disk.getItem(OLD_HISTORY) ?? "[]");
            } catch {
                old = null;
            }

            // No records at all: nothing in it is anybody's.
            if (!Array.isArray(old) || old.length === 0) {
                disk.removeItem(OLD_HISTORY);

                return;
            }

            const mine = old.filter((each) => each?.person === account);

            if (mine.length === 0) {
                return;
            }

            const now = JSON.parse(self.get(HISTORY, account) ?? "[]");
            const kept = [...mine, ...(Array.isArray(now) ? now : [])].slice(-HISTORY_MAX);

            if (self.set(HISTORY, JSON.stringify(kept), account)) {
                const others = old.filter((each) => each?.person !== account);

                if (others.length === 0) {
                    disk.removeItem(OLD_HISTORY);
                } else {
                    disk.setItem(OLD_HISTORY, JSON.stringify(others));
                }
            }
        } catch {
            // Storage can be denied or hold something else: the old records stay where they are.
        }
    };

    const self = {
        identify(account) {
            if (account === person && locked === (account === null)) {
                return;
            }

            person = account;
            locked = account === null;
            pending.clear();

            if (account !== null) {
                moveOldHistory(account);
            }

            removeMatching((key) => legacy(key) && key !== OLD_HISTORY);
        },
        get(key, account = person) {
            const name = scoped(key, account);

            if (name === null) {
                return null;
            }

            if (pending.has(name)) {
                return pending.get(name);
            }

            try {
                return storage().getItem(name);
            } catch {
                return null;
            }
        },
        /** null removes a value. Return whether it also reached disk. */
        set(key, value, account = person) {
            const name = scoped(key, account);

            if (name === null) {
                return false;
            }

            pending.set(name, value);

            try {
                if (value === null) {
                    storage().removeItem(name);
                } else {
                    storage().setItem(name, value);
                }

                pending.delete(name);

                return true;
            } catch {
                return false;
            }
        },
        /** Remove this editor's stored values, never a newer edit from another tab. Drop this page's fallback too. */
        removeIf(key, values, account = person) {
            const name = scoped(key, account);

            if (name === null) {
                return false;
            }

            try {
                const disk = storage();

                if (values.includes(disk.getItem(name))) {
                    disk.removeItem(name);
                }

                pending.delete(name);

                return true;
            } catch {
                pending.set(name, null);

                return false;
            }
        },
        clear() {
            person = null;
            locked = true;
            pending.clear();
            removeMatching((key) => key.startsWith(PREFIX) || legacy(key));
        },
    };

    return self;
}

export const personStorage = createPersonStorage();
