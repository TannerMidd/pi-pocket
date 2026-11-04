// Browser-local content belongs to a person, never to the next account that uses this browser.
const PREFIX = "pocket.person.";
// Old versions did not know whose drafts these were. Do not assign them to whoever signs in next.
const legacy = (key) =>
    /^(pocket\.(draft\.|pastes\.|attached\.|notesDraft\.|viewed\.|history(?:$|\.)|pip\.draft$))/.test(
        key,
    );

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

    return {
        identify(account) {
            if (account === person && locked === (account === null)) {
                return;
            }

            person = account;
            locked = account === null;
            pending.clear();
            removeMatching(legacy);
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
}

export const personStorage = createPersonStorage();
