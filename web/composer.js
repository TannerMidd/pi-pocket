// The message box: send, steer or queue while busy, attach files, mention files with @, run commands with !, recall
// what was sent before (↑, Ctrl+R), fold long pastes, pick the model, stop.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "./avatar.js";
import { chatUnread, TypingLine } from "./chat.js";
import {
    clearPendingCommand,
    loadTemplates,
    parseCommand,
    parseTemplate,
    planAvailable,
    suggestCommands,
} from "./commands.js";
import { loadFiles, mentionAt, mentionText, suggestFiles } from "./files.js";
import { remember, searchHistory, sentHistory } from "./history.js";
import {
    actions,
    attempt,
    canSteer,
    collab,
    drafts,
    notify,
    openSheet,
    store,
    typing,
    uid,
} from "./store.js";
import { branchAvailable, headLabel } from "./sheets/branch.js";
import { formatBytes, formatTokens, html, Icon, Marked, modelLabel, Spinner } from "./ui.js";

const coarse = matchMedia("(pointer: coarse)").matches;
/** The newest "Send to Pi" text already put into a message box (see `insertIntoComposer`). */
let insertedUpTo = 0;

/** Pasted text this long goes into the box as a placeholder; the message goes out with the text in its place. */
const PASTE_LINES = 20;
const PASTE_CHARS = 2000;
const PASTED = /\[Pasted text #(\d+)[^\]\n]*\]/g;
/** Sent messages longer than this are not kept for ↑: a long paste would crowd out the rest. */
const REMEMBER_CHARS = 20_000;
/** An @mention of a file (with a dot or a slash, unlike a person's name), for the Send files chip. */
const MENTIONS_FILE = /(?:^|[\s([{])@(?:"[^"\n]+"|[^\s"]*[./][^\s"]*)/;
const INLINE_KEY = "pocket.inlineFiles";

const pasteKey = (id) => `pocket.pastes.${id ?? "home"}`;

/** Each conversation's pastes by number, kept with its draft so a reload keeps them. */
function loadPastes(id) {
    try {
        return JSON.parse(localStorage.getItem(pasteKey(id)) ?? "{}");
    } catch {
        return {};
    }
}

function savePastes(id, pastes) {
    try {
        if (Object.keys(pastes).length === 0) {
            localStorage.removeItem(pasteKey(id));
        } else {
            localStorage.setItem(pasteKey(id), JSON.stringify(pastes));
        }
    } catch {
        notify("warning", "This browser has no room to keep the paste after a reload.");
    }
}

/** The message with each paste's placeholder replaced by what was pasted. */
const expandPastes = (text, pastes) => text.replace(PASTED, (whole, n) => pastes[n] ?? whole);

/** Take turns: who drives, who asked, and the buttons to hand over, ask, or take the wheel. */
function DriverBar() {
    const { view, me, users, presence } = store.state;
    const turns = view.turns;
    const [handing, setHanding] = useState(false);

    if (!turns?.on) {
        return null;
    }

    const name = (id) => users.find((user) => user.id === id)?.name ?? "someone";
    const driving = turns.driver === me?.id;
    const driverHere =
        turns.driver !== undefined && presence.some((person) => person.id === turns.driver);
    const run = (action, to) =>
        attempt(() => actions.turns(action, to)).then(() => setHanding(false));

    if (driving) {
        const others = presence.filter(
            (person) => person.id !== me?.id && person.role !== "viewer",
        );

        return html`<div class="driver-bar mine">
            <span class="driver-label">🚗 You're driving</span>
            ${turns.asks.map(
                (id) => html`<span class="driver-ask">
                    ${name(id)} asks to drive <button class="link small" onClick=${() => run("handover", id)}>Hand over</button>
                </span>`,
            )}
            <span class="grow"></span>
            ${
                others.length > 0 &&
                html`<button class="link small" onClick=${() => setHanding(!handing)}>
                    Hand over…
                </button>`
            }
            <button class="link small" onClick=${() => run("release")}>Let go</button>
            ${
                handing &&
                html`<div class="driver-pick">
                    ${others.map(
                        (person) => html`<button
                            class="chip"
                            onClick=${() => run("handover", person.id)}
                        >
                            <${Avatar} person=${person} size=${16} /> ${person.name}
                        </button>`,
                    )}
                </div>`
            }
        </div>`;
    }

    const asked = turns.asks.includes(me?.id);
    const canTake = !driverHere || me?.role === "owner";

    return html`<div class="driver-bar">
        <span class="driver-label">
            ${turns.driver === undefined ? "🚗 No one is driving" : `🚗 ${name(turns.driver)} is driving${driverHere ? "" : " (away)"}`}
        </span>
        <span class="grow"></span>
        ${
            turns.driver !== undefined &&
            driverHere &&
            html`<button class="button small" disabled=${asked} onClick=${() => run("ask")}>
                ${asked ? "Asked ✓" : "Ask to drive"}
            </button>`
        }
        ${
            canTake &&
            html`<button class="button small primary" onClick=${() => run("claim")}>
                Take the wheel
            </button>`
        }
    </div>`;
}

/** Plan mode: Pi proposes and changes nothing until someone here approves its plan. */
function PlanBar({ blocked }) {
    const { view } = store.state;

    if (!view.plan?.on || !planAvailable()) {
        return null;
    }

    // A subagent follows its session's plan mode; it is approved there.
    const subagent = view.conversation?.kind === "subagent";

    return html`<div class="plan-bar">
        <span class="grow">
            <strong>Plan mode.</strong> ${subagent ? "This subagent follows its session: it reads, and changes nothing." : "Pi reads and proposes; nothing changes until you approve."}
        </span>
        ${
            !blocked &&
            !subagent &&
            html`<button class="link small" onClick=${() => attempt(() => actions.setPlan(false))}>
                Turn off
            </button>
            <button
                class="button small primary"
                disabled=${view.live.busy}
                onClick=${() => attempt(actions.approvePlan)}
            >
                Approve plan
            </button>`
        }
    </div>`;
}

/** Done when: the check Pi works toward, how many checks it took, and a way to drop it. */
function GoalBar() {
    const { goal } = store.state.view;

    if (!goal) {
        return null;
    }

    const command = html`<span class="mono">${goal.command}</span>`;
    const text =
        goal.status === "met"
            ? html`<strong>Done:</strong> ${command} passes (check ${goal.tries} of ${goal.max}).`
            : goal.status === "gave-up"
              ? html`<strong>Stopped:</strong> ${command} still fails after ${goal.max} checks.`
              : html`<strong>Until</strong> ${command} passes${goal.tries > 0 ? ` · check ${goal.tries} of ${goal.max} failed` : ""}.`;

    return html`<div class=${`goal-bar ${goal.status}`}>
        <span class="grow">${text}</span>
        ${
            canSteer() &&
            html`<button class="link small" onClick=${() => attempt(actions.clearGoal)}>
                ${goal.status === "working" ? "Drop" : "Dismiss"}
            </button>`
        }
    </div>`;
}

export function Composer() {
    const { view, conversationId, me, users, server } = store.state;
    const [text, setText] = useState(() => drafts.get(conversationId));
    const [files, setFiles] = useState([]);
    const [steer, setSteer] = useState(true);
    const [sending, setSending] = useState(false);
    // Slash command suggestions: the highlighted one, and whether Escape hid the list.
    const [pick, setPick] = useState(0);
    const [hideCommands, setHideCommands] = useState(false);
    // File mentions: where the caret is, and the mention Escape hid (by where it starts).
    const [caret, setCaret] = useState(() => drafts.get(conversationId).length);
    const [hiddenMention, setHiddenMention] = useState(null);
    const [pastes, setPastes] = useState(() => loadPastes(conversationId));
    // ↑ through what was sent before: where in that list, and the draft ↓ comes back to. Ctrl+R searches it.
    const [browsing, setBrowsing] = useState(null);
    const [searching, setSearching] = useState(false);
    const [inlineFiles, setInlineFiles] = useState(() => localStorage.getItem(INLINE_KEY) === "1");
    const box = useRef(null);
    const picker = useRef(null);
    const list = useRef(null);
    // One per `!` command: sending it again after a lost reply runs it once.
    const requestId = useRef(uid());
    const runningCommand = useRef(false);
    const busy = view.live.busy;
    const agent = view.agent;

    useEffect(() => {
        const draft = drafts.get(conversationId);

        setText(draft);
        setCaret(draft.length);
        setPastes(loadPastes(conversationId));
        setBrowsing(null);
        setSearching(false);
    }, [conversationId]);
    // Text sent here from the chat, the notes ("Send to Pi"), or another app (Share) goes after whatever is in the box,
    // once: the message box is made again for every session, and must not add the same text there. Shared files are
    // attached the same way.
    const insert = store.state.composerInsert;

    useEffect(() => {
        if (!insert || insert.n <= insertedUpTo) {
            return;
        }

        insertedUpTo = insert.n;

        if (insert.files?.length > 0) {
            addFiles(insert.files);
        }

        if (insert.text === "") {
            return;
        }

        const current = drafts.get(conversationId);

        update(
            current.trim() === ""
                ? insert.text
                : `${current.replace(/\s+$/, "")}${insert.inline ? " " : "\n\n"}${insert.text}`,
        );
        requestAnimationFrame(() => {
            const element = box.current;

            if (!element) {
                return;
            }

            element.focus();
            element.setSelectionRange(element.value.length, element.value.length);
        });
    }, [insert?.n]);
    useEffect(() => {
        const element = box.current;

        if (!element) {
            return;
        }

        element.style.height = "auto";
        element.style.height = `${Math.min(element.scrollHeight, innerHeight * 0.4)}px`;
    }, [text]);

    const update = (value, at = value.length) => {
        setText(value);
        setCaret(at);
        drafts.set(conversationId, value);
        setPick(0);

        if (!value.startsWith("/") || value === "/") {
            setHideCommands(false);
        }

        if (value.startsWith("/")) {
            void loadTemplates().catch(() => {});
        }

        // A command is not a message to Pi: no "typing to Pi" for it.
        typing(value.trim() === "" || value.startsWith("/") ? null : "pi");
    };

    const blocked = collab() && view.turns?.on && view.turns.driver !== me?.id;
    const globalCommand = (command) =>
        me?.role === "owner" && command?.extension === true && command.scope === "global";
    const full = expandPastes(text, pastes);
    const parsed = parseCommand(full);
    const globalOnly =
        blocked &&
        me?.role === "owner" &&
        ((server?.extensionCommands ?? []).some((command) => command.scope === "global") ||
            globalCommand(parsed?.command));
    // Ctrl+R: what was sent before that has the words in the box.
    const recalled = searching ? searchHistory(text) : [];
    const chosenRecall = recalled[Math.min(pick, recalled.length - 1)];
    const suggestions =
        hideCommands || searching
            ? []
            : suggestCommands(text).filter((command) => !blocked || globalCommand(command));
    const chosen = suggestions[Math.min(pick, suggestions.length - 1)];
    const template = parsed ? null : parseTemplate(full);
    // `!command` runs in the session's folder and Pi sees it; `!!command`, only the people here.
    const shell = text.startsWith("!")
        ? { context: !text.startsWith("!!"), command: text.replace(/^!!?/, "").trim() }
        : null;
    const mentionsFiles = !shell && !parsed && MENTIONS_FILE.test(text);
    const pasted = PASTED.test(text);

    PASTED.lastIndex = 0;
    // The @path being typed at the caret, and the files that match it. Slash command names come first.
    const typed = suggestions.length === 0 && !searching && !shell ? mentionAt(text, caret) : null;
    const mention = typed && typed.start !== hiddenMention ? typed : null;
    const found = mention ? suggestFiles(mention.query) : null;
    const matches = found?.items ?? [];
    const chosenFile = matches[Math.min(pick, matches.length - 1)];

    // A new mention checks the folder's list again, in the background; a hidden one shows again once it is gone.
    useEffect(() => {
        if (mention) {
            loadFiles();
        }
    }, [mention?.start, conversationId]);
    useEffect(() => {
        if (!typed && hiddenMention !== null) {
            setHiddenMention(null);
        }
    }, [typed === null]);
    // Arrowing through a long list keeps the highlighted one in view.
    useEffect(
        () => list.current?.querySelector(".command.on")?.scrollIntoView({ block: "nearest" }),
        [pick],
    );

    const focusEnd = () =>
        requestAnimationFrame(() => {
            const element = box.current;

            if (!element) {
                return;
            }

            element.focus();
            element.setSelectionRange(element.value.length, element.value.length);
        });

    /** Run a slash command. The text goes away once it worked; attached files stay for the next message. */
    const runCommand = async ({ command, arg }) => {
        if (runningCommand.current || (blocked && !globalCommand(command))) {
            return;
        }

        runningCommand.current = true;
        const draft = drafts.get(conversationId);

        setSending(true);
        const ok = await attempt(async () => {
            await command.run(arg);

            return true;
        });

        runningCommand.current = false;
        setSending(false);

        if (ok && drafts.get(conversationId) === draft) {
            update("");
        }
    };

    /**
     * A picked file goes into the box in place of what was typed, with a space after it. A folder goes in with its "/",
     * and its own files show next.
     */
    const chooseFile = (item) => {
        const written = mentionText(item.path);
        const rest = text.slice(mention.end);
        const space = item.dir || /^\s/.test(rest) ? "" : " ";
        const at = mention.start + written.length + (item.dir ? 0 : 1);

        update(`${text.slice(0, mention.start)}${written}${space}${rest}`, at);
        requestAnimationFrame(() => {
            const element = box.current;

            if (!element) {
                return;
            }

            element.focus();
            element.setSelectionRange(at, at);
        });
    };

    /** A tapped suggestion: commands that take text, and prompt templates, fill the box; the others run at once. */
    const choose = (command) => {
        if (blocked && !globalCommand(command)) {
            return;
        }

        if (command.args || command.template) {
            update(`/${command.name} `);
            focusEnd();
        } else if (!runningCommand.current) {
            if (command.extension) {
                update(`/${command.name}`);
            }

            runCommand({ command, arg: "" });
        }
    };

    const forget = (list) => {
        for (const file of list) {
            if (file.preview) {
                URL.revokeObjectURL(file.preview);
            }
        }
    };

    const uploading = files.some((file) => file.state === "uploading");
    const canSend =
        !sending &&
        !uploading &&
        (!blocked || globalCommand(parsed?.command)) &&
        (text.trim() !== "" || files.some((file) => file.state === "done"));

    /** What went out stays for ↑; its pastes are done with. */
    const sent = (full) => {
        if (full.length <= REMEMBER_CHARS) {
            remember(full);
        }

        setPastes({});
        savePastes(conversationId, {});
        setBrowsing(null);
        update("");
    };

    /** Run `!command` in the session's folder. Its entry shows once it is done; until then, a row says it runs. */
    const runShell = async (full) => {
        const command = full.replace(/^!!?/, "").trim();

        if (command === "") {
            return notify("info", "Say which command to run, such as !git status.");
        }

        setSending(true);
        const started = await attempt(() =>
            actions.shell(command, !full.startsWith("!!"), requestId.current),
        );

        setSending(false);

        if (!started) {
            return;
        }

        store.set((state) => ({
            pendingShells: [
                ...state.pendingShells,
                { taskId: started.taskId, command, conversationId, at: Date.now() },
            ],
        }));
        requestId.current = uid();
        sent(full);
    };

    const send = async () => {
        if (!canSend || runningCommand.current) {
            return;
        }

        if (parsed) {
            if (full.length <= REMEMBER_CHARS) {
                remember(full);
            }

            return runCommand(parsed);
        }

        if (shell) {
            return runShell(full);
        }

        setSending(true);
        const attachments = files
            .filter((file) => file.state === "done")
            .map((file) => file.attachment);
        const ok = await attempt(() =>
            actions.submit(
                full,
                attachments,
                busy && steer ? "steer" : "followUp",
                inlineFiles && mentionsFiles,
            ),
        );

        setSending(false);

        if (ok) {
            sent(full);
            forget(files);
            setFiles([]);

            if (!coarse) {
                box.current?.focus();
            }
        }
    };

    /** Put a message sent before into the box, to send again or change. */
    const recall = (value, at = value.length) => {
        update(value, at);
        requestAnimationFrame(() => box.current?.setSelectionRange(at, at));
    };

    /**
     * ↑ in an empty box, or with the caret at its very start, goes back through what was sent; once going back, ↑ on
     * the first line goes further and ↓ on the last line comes forward, then to the draft. A draft is never replaced by
     * moving the caret up through it.
     */
    const browseHistory = (event) => {
        const element = event.currentTarget;

        if (element.selectionStart !== element.selectionEnd) {
            return false;
        }

        const list = sentHistory();

        if (event.key === "ArrowUp") {
            const starts =
                text === "" ||
                element.selectionStart === 0 ||
                (browsing !== null && !text.slice(0, element.selectionStart).includes("\n"));

            if (!starts) {
                return false;
            }

            const index = (browsing?.index ?? list.length) - 1;

            if (index < 0) {
                return false;
            }

            setBrowsing({ index, draft: browsing?.draft ?? text });
            recall(list[index]);

            return true;
        }

        if (browsing === null || text.slice(element.selectionEnd).includes("\n")) {
            return false;
        }

        const index = browsing.index + 1;

        if (index < list.length) {
            setBrowsing({ ...browsing, index });
            recall(list[index]);
        } else {
            setBrowsing(null);
            recall(browsing.draft);
        }

        return true;
    };

    const onKey = (event) => {
        if (
            event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "r"
        ) {
            event.preventDefault();
            setSearching(!searching);
            setPick(0);

            return;
        }

        // While searching, these keys are the search's: with nothing found, Enter must not send the search words.
        if (searching && !event.isComposing) {
            const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];

            if (move !== undefined) {
                event.preventDefault();

                if (recalled.length > 0) {
                    setPick(
                        (Math.min(pick, recalled.length - 1) + move + recalled.length) %
                            recalled.length,
                    );
                }

                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                setSearching(false);

                return;
            }

            if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                event.preventDefault();

                if (chosenRecall === undefined) {
                    return;
                }

                setSearching(false);
                recall(chosenRecall);

                return;
            }
        }

        if (matches.length > 0 && !event.isComposing) {
            const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];

            if (move !== undefined) {
                event.preventDefault();
                setPick(
                    (Math.min(pick, matches.length - 1) + move + matches.length) % matches.length,
                );

                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                setHiddenMention(mention.start);

                return;
            }

            // Tab completes; Enter completes too, unless the file's path is typed out already, which sends.
            const typedOut = !chosenFile.dir && mention.query === chosenFile.path;

            if (
                event.key === "Tab" ||
                (event.key === "Enter" && !event.shiftKey && !coarse && !typedOut)
            ) {
                event.preventDefault();
                chooseFile(chosenFile);

                return;
            }
        }

        if (suggestions.length > 0 && !event.isComposing) {
            const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];

            if (move !== undefined) {
                event.preventDefault();
                setPick(
                    (Math.min(pick, suggestions.length - 1) + move + suggestions.length) %
                        suggestions.length,
                );

                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                setHideCommands(true);

                return;
            }

            // Tab completes; Enter completes too, unless the name is typed out already, which runs it.
            const typedOut = parsed && text.trim() === `/${chosen.name}`;

            if (
                event.key === "Tab" ||
                (event.key === "Enter" && !event.shiftKey && !coarse && !typedOut)
            ) {
                event.preventDefault();
                choose(chosen);

                return;
            }
        }

        if (
            (event.key === "ArrowUp" || event.key === "ArrowDown") &&
            !event.isComposing &&
            !event.shiftKey &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
        ) {
            if (browseHistory(event)) {
                event.preventDefault();
            }

            return;
        }

        if (event.key === "Enter" && !event.shiftKey && !coarse && !event.isComposing) {
            event.preventDefault();
            send();
        }
    };

    const addFiles = (list) => {
        if (blocked) {
            return;
        }

        for (const file of list) {
            const key = uid();
            const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;

            setFiles((current) => [
                ...current,
                { key, name: file.name, size: file.size, state: "uploading", preview },
            ]);
            actions.upload(file).then(
                (attachment) =>
                    setFiles((current) =>
                        current.map((each) =>
                            each.key === key ? { ...each, state: "done", attachment } : each,
                        ),
                    ),
                (error) => {
                    notify("error", `Upload failed: ${error.message}`);

                    if (preview) {
                        URL.revokeObjectURL(preview);
                    }

                    setFiles((current) => current.filter((each) => each.key !== key));
                },
            );
        }
    };

    const onPaste = (event) => {
        const pastedFiles = [...(event.clipboardData?.files ?? [])];

        if (pastedFiles.length > 0) {
            event.preventDefault();
            addFiles(pastedFiles);

            return;
        }

        // A long paste goes in as a placeholder, so the box stays readable; the message goes out with the text.
        const value = event.clipboardData?.getData("text/plain") ?? "";
        const lines = value.replace(/\n$/, "").split("\n").length;

        if (lines <= PASTE_LINES && value.length <= PASTE_CHARS) {
            return;
        }

        event.preventDefault();
        const n = Math.max(0, ...Object.keys(pastes).map(Number)) + 1;
        const label = `[Pasted text #${n} · ${lines > 1 ? `${lines} lines` : `${value.length} characters`}]`;
        const next = { ...pastes, [n]: value };

        setPastes(next);
        savePastes(conversationId, next);
        const element = event.currentTarget;
        const at = element.selectionStart + label.length;

        recall(
            `${text.slice(0, element.selectionStart)}${label}${text.slice(element.selectionEnd)}`,
            at,
        );
    };

    const placeholder = globalOnly
        ? "Run a global command…"
        : busy
          ? steer
              ? "Steer the current run…"
              : "Queue a follow-up…"
          : coarse
            ? "Message Pi…"
            : "Message Pi… (/ commands · @ files · ! shell)";
    const inbox = view.inbox ?? [];
    const queuedBy = (item) =>
        item.by === undefined
            ? ""
            : item.by === me?.id
              ? " · you"
              : ` · ${users.find((user) => user.id === item.by)?.name ?? "someone"}`;

    if (collab() && !canSteer()) {
        return html`<footer class="composer-wrap">
            <${TypingLine} where="pi" />
            <div class="view-only">
                <span>
                    <strong>View only.</strong> You can read along, react, and chat with the people here.
                </span>
                <button class="button small" onClick=${() => openSheet({ type: "chat" })}>
                    <${Icon} name="chat" size=${15} /> Chat
                </button>
            </div>
            <${StatusLine} />
        </footer>`;
    }

    const level =
        agent?.thinkingLevel && agent.thinkingLevel !== "off" && agent.reasoning
            ? agent.thinkingLevel
            : null;

    return html`<footer class="composer-wrap">
        <${TypingLine} where="pi" />
        ${
            inbox.length > 0 &&
            html`<div class="inbox">
                ${inbox.map(
                    (item) => html`<div class="queued">
                        <span class="queued-mode">
                            ${item.mode === "steer" ? "Steer" : item.mode === "followUp" ? "Queued" : "Note"}
                            <span class="muted">${queuedBy(item)}</span>
                        </span>
                        <span class="queued-text">${item.text ?? ""}</span>
                        ${
                            canSteer() &&
                            (!blocked || item.by === me?.id) &&
                            html`<button
                                class="icon-button small"
                                aria-label="Withdraw"
                                onClick=${() => attempt(() => actions.withdraw(item.id))}
                            >
                                <${Icon} name="close" size=${14} />
                            </button>`
                        }
                    </div>`,
                )}
            </div>`
        }
        ${collab() && html`<${DriverBar} />`}
        <${PlanBar} blocked=${blocked} />
        <${GoalBar} />
        ${
            blocked && !globalOnly
                ? html`${
                      busy &&
                      html`<div class="composer-row stop-only">
                          <span class="muted small grow">Pi is working…</span>
                          <button
                              class="round stop"
                              aria-label="Stop"
                              onClick=${() => attempt(actions.abort)}
                          >
                              <${Icon} name="stop" size=${16} />
                          </button>
                      </div>`
                  }`
                : html`${
                      searching &&
                      html`<div
                          class="commands history-options"
                          role="listbox"
                          aria-label="Sent before"
                          ref=${list}
                      >
                          <div class="file-note">
                              Sent before${text.trim() ? ` with “${text.trim()}”` : ""} · Enter puts it in the box · Esc closes
                          </div>
                          ${recalled.map(
                              (each) => html`<button
                                  class=${`command ${each === chosenRecall ? "on" : ""}`}
                                  role="option"
                                  aria-selected=${each === chosenRecall}
                                  onMouseDown=${(event) => event.preventDefault()}
                                  onClick=${() => {
                                      setSearching(false);
                                      recall(each);
                                  }}
                              >
                                  <span class="command-description history-text">
                                      ${each.replace(/\s+/g, " ")}
                                  </span>
                              </button>`,
                          )}
                          ${
                              recalled.length === 0 &&
                              html`<div class="file-note">
                                  Nothing sent from this browser matches.
                              </div>`
                          }
                      </div>`
                  }
                ${
                    shell &&
                    html`<div class="command-hint">
                        <span class="command-name">${shell.context ? "!" : "!!"}</span> <span class="muted">· runs in this session's folder · ${shell.context ? "Pi sees the output (!! to keep it from Pi)" : "only the people here see the output"}</span>
                    </div>`
                }
                ${
                    pasted &&
                    !shell &&
                    html`<div class="command-hint muted">
                        Pasted text goes out in full where its placeholder is.
                    </div>`
                }
                ${
                    mentionsFiles &&
                    !mention &&
                    !searching &&
                    html`<div class="command-hint wraps">
                        <span class="muted">
                            ${inlineFiles ? "Mentioned files go with the message." : "Pi reads the files you mention."}
                        </span>
                        ${" "}
                        <button
                            class="link small"
                            onMouseDown=${(event) => event.preventDefault()}
                            onClick=${() => {
                                localStorage.setItem(INLINE_KEY, inlineFiles ? "0" : "1");
                                setInlineFiles(!inlineFiles);
                            }}
                        >
                            ${inlineFiles ? "Let Pi read them" : "Send them along"}
                        </button>
                    </div>`
                }
                ${
                    mention &&
                    (matches.length > 0 || found.loading) &&
                    html`<div
                        class="commands file-options"
                        role="listbox"
                        aria-label="Files"
                        ref=${list}
                    >
                        ${matches.map(
                            (item) => html`<button
                                key=${item.path}
                                class=${`command file-option ${item === chosenFile ? "on" : ""}`}
                                role="option"
                                aria-selected=${item === chosenFile}
                                onMouseDown=${(event) => event.preventDefault()}
                                onClick=${() => chooseFile(item)}
                            >
                                <${Icon}
                                    name=${item.dir ? "folder" : "file"}
                                    size=${14}
                                    class="file-icon"
                                />
                                <span class="file-name">
                                    <${Marked} text=${item.name} hits=${item.nameHits} />
                                    ${item.dir ? "/" : ""}
                                </span>
                                <span class="command-description">
                                    <${Marked} text=${item.parent} hits=${item.parentHits} />
                                </span>
                            </button>`,
                        )}
                        ${matches.length === 0 && html`<div class="file-note">Finding files…</div>`}
                        ${
                            found.truncated &&
                            html`<div class="file-note">
                                A large folder: only the files nearest its top are listed.
                            </div>`
                        }
                    </div>`
                }
                ${
                    suggestions.length > 0 &&
                    html`<div class="commands" role="listbox" ref=${list}>
                        ${suggestions.map(
                            (command) => html`<button
                                class=${`command ${command === chosen ? "on" : ""}`}
                                role="option"
                                aria-selected=${command === chosen}
                                onMouseDown=${(event) => event.preventDefault()}
                                onClick=${() => choose(command)}
                            >
                                <span class="command-name">/${command.name}</span>
                                ${
                                    command.args &&
                                    html`<span class="command-args">${command.args}</span>`
                                }
                                <span class="command-description">${command.description}</span>
                            </button>`,
                        )}
                    </div>`
                }
                ${
                    suggestions.length === 0 &&
                    parsed &&
                    html`<div class="command-hint">
                        <span class="command-name">/${parsed.command.name}</span>
                        ${
                            parsed.command.args &&
                            html` <span class="command-args">${parsed.command.args}</span>`
                        } <span class="muted">· ${parsed.command.description} · not sent to Pi</span>
                    </div>`
                }
                ${
                    suggestions.length === 0 &&
                    template &&
                    html`<div class="command-hint">
                        <span class="command-name">/${template.name}</span>
                        ${
                            template.args &&
                            html` <span class="command-args">${template.args}</span>`
                        } <span class="muted">· ${template.skill ? "skill · Pi gets its instructions with your request" : "prompt template · Pi gets it filled in"}</span>
                    </div>`
                }
                <div
                    class="composer"
                    onClick=${(event) => {
                        // The box is one target: a tap on its padding or between its buttons goes to the text.
                        if (
                            event.target === event.currentTarget ||
                            event.target.classList.contains("composer-row")
                        ) {
                            box.current?.focus();
                        }
                    }}
                    onDragOver=${(event) => event.preventDefault()}
                    onDrop=${(event) => {
                        event.preventDefault();
                        addFiles([...(event.dataTransfer?.files ?? [])]);
                    }}
                >
                    ${
                        files.length > 0 &&
                        html`<div class="files">
                            ${files.map(
                                (
                                    file,
                                ) => html`<span class=${`chip ${file.preview ? "with-thumb" : ""}`}>
                                    ${
                                        file.preview &&
                                        html`<img class="chip-thumb" src=${file.preview} alt="" />`
                                    }
                                    ${file.state === "uploading" ? html`<${Spinner} />` : file.preview ? "" : "📎"} ${file.name} <span class="muted">${formatBytes(file.size)}</span>
                                    <button
                                        class="icon-button small"
                                        aria-label=${`Remove ${file.name}`}
                                        onClick=${() => {
                                            forget([file]);
                                            setFiles((current) =>
                                                current.filter((each) => each.key !== file.key),
                                            );
                                        }}
                                    >
                                        <${Icon} name="close" size=${12} />
                                    </button>
                                </span>`,
                            )}
                        </div>`
                    }
                    <textarea
                        ref=${box}
                        rows="1"
                        value=${text}
                        placeholder=${placeholder}
                        onInput=${(event) => {
                            setBrowsing(null);

                            if (event.currentTarget.value === "") {
                                void attempt(() => clearPendingCommand(conversationId));
                            }

                            update(event.currentTarget.value, event.currentTarget.selectionStart);
                        }}
                        onKeyDown=${onKey}
                        onKeyUp=${(event) => setCaret(event.currentTarget.selectionStart)}
                        onClick=${(event) => setCaret(event.currentTarget.selectionStart)}
                        onFocus=${() => loadFiles({ ifMissing: true })}
                        onPaste=${onPaste}
                        enterkeyhint=${coarse ? "enter" : "send"}
                    ></textarea>
                    <div class="composer-row">
                        <${PlacesButton} />
                        <button
                            class="icon-button"
                            aria-label="Attach files"
                            disabled=${blocked}
                            onClick=${() => picker.current?.click()}
                        >
                            <${Icon} name="clip" />
                        </button>
                        <input
                            ref=${picker}
                            type="file"
                            multiple
                            hidden
                            disabled=${blocked}
                            onChange=${(event) => {
                                addFiles([...event.currentTarget.files]);
                                event.currentTarget.value = "";
                            }}
                        />
                        <button
                            class=${`chip model-chip ${agent?.available === false ? "warn" : ""}`}
                            disabled=${blocked}
                            onClick=${() => openSheet({ type: "model" })}
                        >
                            <span class="glyph">✦</span> ${modelLabel(agent)}
                            ${level && html`<span class="muted"> ${level}</span>`}
                        </button>
                        ${
                            planAvailable() &&
                            view.conversation?.kind !== "subagent" &&
                            html`<button
                                class=${`chip toggle ${view.plan?.on ? "on" : ""}`}
                                disabled=${blocked}
                                title="Plan mode: Pi reads and proposes, and changes nothing until you approve"
                                onClick=${() => attempt(() => actions.setPlan(!view.plan?.on))}
                            >
                                Plan
                            </button>`
                        }
                        ${
                            busy &&
                            html`<button
                                class=${`chip toggle ${steer ? "on" : ""}`}
                                disabled=${blocked}
                                onClick=${() => setSteer(!steer)}
                                title="Steer joins the running work; off queues a follow-up"
                            >
                                Steer
                            </button>`
                        }
                        <span class="grow"></span>
                        ${
                            busy &&
                            html`<button
                                class="round stop"
                                aria-label="Stop"
                                onClick=${() => attempt(actions.abort)}
                            >
                                <${Icon} name="stop" size=${16} />
                            </button>`
                        }
                        ${
                            (!busy || text.trim() !== "" || files.length > 0) &&
                            html`<button
                                class="round send"
                                aria-label="Send"
                                disabled=${!canSend}
                                onClick=${send}
                            >
                                ${
                                    sending
                                        ? html`<${Spinner} />`
                                        : html`<${Icon} name="send" size=${18} />`
                                }
                            </button>`
                        }
                    </div>
                </div>`
        }
        <${StatusLine} />
    </footer>`;
}

/**
 * Phones: the session's places (Files, Changes, the browser…) from beside the message box, where a thumb reaches; the
 * top bar's buttons are a stretch with one hand. A dot when the chat has news or a page is open.
 */
function PlacesButton() {
    const { browser } = store.state;
    const news =
        (collab() && chatUnread() > 0) ||
        (browser?.open && browser.url !== "" && browser.url !== "about:blank");

    return html`<button
        class="icon-button places-button badge-host"
        aria-label="Places: Files, Changes, Browser, and more"
        title="Places (or swipe up here)"
        onClick=${() => openSheet({ type: "places" })}
    >
        <${Icon} name="grid" />
        ${news && html`<span class="browser-dot" aria-hidden="true"></span>`}
    </button>`;
}

function StatusLine() {
    const { view, connection, guard } = store.state;
    const stats = view.stats ?? {};
    const window = view.agent?.contextWindow;
    const parts = [];

    if (connection !== "open") {
        parts.push(
            html`<span class="warn">
                ${connection === "connecting" ? "connecting…" : "reconnecting…"}
            </span>`,
        );
    }

    // The git branch, first as in an editor's status bar: a tap switches it.
    if (view.branch) {
        const label = html`<${Icon} name="fork" size=${11} />
            <span>${headLabel(view.branch)}</span>`;

        parts.push(
            branchAvailable()
                ? html`<button
                      class="branch"
                      title=${view.branch.detached ? "No branch: switch to one" : "Switch or make a branch"}
                      onClick=${() => openSheet({ type: "branch" })}
                  >
                      ${label}
                  </button>`
                : html`<span class="branch" title="The git branch">${label}</span>`,
        );
    }

    parts.push(
        html`<span title=${(view.viewers ?? []).join(", ")}>
            ${view.clients} client${view.clients === 1 ? "" : "s"}
        </span>`,
    );

    if (stats.cacheRate !== undefined) {
        parts.push(html`<span>cache ${Math.round(stats.cacheRate * 100)}%</span>`);
    }

    if (window) {
        const percent = stats.contextTokens ? Math.round((stats.contextTokens / window) * 100) : 0;

        parts.push(html`<span>${percent}%/${formatTokens(window)}</span>`);
    }

    // The session's spend, its subagents' included, and its limit when it has one.
    const spend = view.conversation?.spend;
    const spent = spend?.spent ?? stats.cost ?? 0;

    parts.push(
        html`<span class=${spend?.budget !== undefined && spent >= spend.budget ? "warn" : ""}>
            $${spent.toFixed(2)}
            ${spend?.budget !== undefined ? `/$${spend.budget.toFixed(2)}` : ""}
        </span>`,
    );

    // On but not loaded: the guard blocks bash, write, and edit until it loads or is turned off.
    if (guard?.enabled && guard.available === false) {
        parts.push(
            html`<button
                class="guard off"
                title=${guard.detail}
                onClick=${() => openSheet({ type: "extensions" })}
            >
                <${Icon} name="shield" size=${11} /> guard failed
            </button>`,
        );
    } else if (guard?.enabled) {
        parts.push(
            html`<button
                class="guard"
                title=${guard.detail}
                onClick=${() => openSheet({ type: "extensions" })}
            >
                <${Icon} name="shield" size=${11} /> guard
            </button>`,
        );
    } else if (guard?.available) {
        parts.push(
            html`<button
                class="guard off"
                title=${guard.detail}
                onClick=${() => openSheet({ type: "extensions" })}
            >
                <${Icon} name="shield" size=${11} /> guard off
            </button>`,
        );
    }

    return html`<div class="status-line">
        ${parts.flatMap((part, index) =>
            index === 0 ? [part] : [html`<span class="dot">·</span>`, part],
        )}
    </div>`;
}
