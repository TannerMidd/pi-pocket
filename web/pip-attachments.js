// PiP's browser-only draft, kept across panel mounts. No main-composer state or conversation lookup.
/** A scoped draft. Async work holds its original scope and item/token identity, never a newer draft. */
export function createPipDraft({ loadText, saveText, upload, onError }) {
    const listeners = new Set();
    let account;
    let id;
    let generation = 0;
    let revision = 0;
    // Each file's key, unique in this draft: crypto.randomUUID is missing on plain-http pages (a LAN address).
    let keys = 0;
    let state = { text: loadText(), files: [], pending: null };

    const emit = () => {
        for (const listener of listeners) {
            listener(state);
        }
    };

    const changeText = (text) => {
        revision++;
        state = { ...state, text };
        saveText(text);
        emit();
    };

    const removeFile = (key) => {
        const file = state.files.find((each) => each.key === key);

        if (!file) {
            return;
        }

        if (file.preview) {
            URL.revokeObjectURL(file.preview);
        }

        state = { ...state, files: state.files.filter((each) => each !== file) };
        emit();
    };

    return {
        get state() {
            return state;
        },
        subscribe(listener) {
            listeners.add(listener);

            return () => listeners.delete(listener);
        },
        scope(nextAccount, nextId) {
            // Unknown authentication during reconnect is not an account change.
            if (nextAccount === undefined) {
                return;
            }

            const changedAccount = account !== undefined && account !== nextAccount;
            const loggedOut = nextAccount === null && account !== null;
            // A missing ID during reconnect is not evidence that PiP's conversation changed.
            const changedId = nextId !== undefined && id !== undefined && id !== nextId;

            account = nextAccount;
            id = nextAccount === null ? undefined : changedAccount ? nextId : (nextId ?? id);

            if (!changedAccount && !changedId && !loggedOut) {
                return;
            }

            generation++;

            for (const file of state.files) {
                if (file.preview) {
                    URL.revokeObjectURL(file.preview);
                }
            }

            state = { ...state, files: [], pending: null };

            if (changedAccount || loggedOut) {
                changeText("");
            } else {
                emit();
            }
        },
        syncText() {
            const saved = loadText();

            if (saved !== state.text) {
                changeText(saved);
            }
        },
        changeText,
        removeFile,
        addFiles(files) {
            if (id === undefined || account == null) {
                onError("PiP is not ready yet. Try again in a moment.");

                return;
            }

            const scope = generation;
            const target = id;

            for (const file of files) {
                const item = {
                    key: `file-${++keys}`,
                    name: file.name,
                    size: file.size,
                    preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
                    state: "uploading",
                };

                state = { ...state, files: [...state.files, item] };
                emit();
                upload(target, file).then(
                    (attachment) => {
                        if (scope !== generation || !state.files.includes(item)) {
                            return;
                        }

                        state = {
                            ...state,
                            files: state.files.map((each) =>
                                each === item ? { ...item, state: "done", attachment } : each,
                            ),
                        };
                        emit();
                    },
                    (error) => {
                        if (scope !== generation || !state.files.includes(item)) {
                            return;
                        }

                        removeFile(item.key);
                        onError(`Upload failed: ${error.message ?? String(error)}`);
                    },
                );
            }
        },
        begin(compact = false) {
            if (
                state.pending ||
                (!compact && state.files.some((file) => file.state === "uploading"))
            ) {
                return null;
            }

            const token = {
                generation,
                text: state.text,
                files: compact ? [] : [...state.files],
            };

            state = { ...state, pending: token };
            changeText("");
            token.revision = revision;

            return token;
        },
        finish(token, success) {
            if (token.generation !== generation || state.pending !== token) {
                return;
            }

            state = { ...state, pending: null };

            if (success) {
                for (const file of token.files) {
                    removeFile(file.key);
                }
            } else if (token.text !== "") {
                // The person can type while sending, or close and reopen the panel. Keep both drafts on failure.
                changeText(
                    revision === token.revision || state.text === ""
                        ? token.text
                        : `${token.text}\n\n${state.text}`,
                );
            }

            emit();
        },
    };
}
