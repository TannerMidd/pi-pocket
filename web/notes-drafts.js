import { personStorage } from "./person-storage.js";

// Keep the starting revision with an unfinished edit: reopening must not silently accept a newer shared save.
export function createNotesDrafts(storage = personStorage) {
    const records = new Map();
    const listeners = new Set();
    const keyFor = (id) => `notesDraft.${id}`;

    const emit = () => {
        for (const listener of listeners) {
            listener();
        }
    };

    const get = (account, id) => {
        const key = JSON.stringify([account, id]);

        if (!records.has(key)) {
            const record = { draft: null, saving: null, error: null, stored: null };

            try {
                const value = storage.get(keyFor(id), account);
                const saved = JSON.parse(value ?? "null");

                if (
                    typeof saved?.text === "string" &&
                    Number.isSafeInteger(saved.base) &&
                    saved.base >= 0
                ) {
                    record.draft = { text: saved.text, base: saved.base };
                    record.stored = value;
                }
            } catch {
                // A damaged value must not stop the editor from opening.
            }

            records.set(key, record);
        }

        return records.get(key);
    };

    const forget = (account, id, record) => {
        // A failed write can leave our earlier draft on disk. Never remove a different tab's newer value.
        const removed = storage.removeIf(
            keyFor(id),
            [JSON.stringify(record.draft), record.stored],
            account,
        );

        // Warn only when a draft of ours reached disk: with blocked storage, nothing can return.
        record.error = removed || record.stored === null ? null : "clear";
        record.draft = null;

        if (removed) {
            record.stored = null;
        }
    };

    return {
        get,
        subscribe(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        clear() {
            records.clear();
            emit();
        },
        edit(account, id, text, base) {
            const record = get(account, id);

            if (record.saving) {
                return;
            }

            record.draft = { text, base: record.draft?.base ?? base };
            const value = JSON.stringify(record.draft);
            const saved = storage.set(keyFor(id), value, account);

            if (saved) {
                record.stored = value;
            }

            record.error = saved ? null : "write";
            emit();
        },
        discard(account, id) {
            const record = get(account, id);

            if (record.saving) {
                return;
            }

            forget(account, id, record);
            emit();
        },
        beginSave(account, id) {
            const record = get(account, id);

            if (!record.draft || record.saving) {
                return null;
            }

            record.saving = record.draft;
            emit();

            return record.saving;
        },
        finishSave(account, id, submitted, success) {
            const record = get(account, id);

            if (record.saving !== submitted) {
                return;
            }

            record.saving = null;

            if (success && record.draft === submitted) {
                forget(account, id, record);
            }

            emit();
        },
    };
}

export const notesDrafts = createNotesDrafts();
