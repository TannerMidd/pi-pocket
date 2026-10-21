// The message box: send, steer or queue while busy, attach files, mention files with @, run commands with !, recall
// what was sent before (↑, Ctrl+R), fold long pastes, pick the model, stop.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "./avatar.js";
import { chatUnread, TypingLine } from "./chat.js";
import {
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
    navigate,
    notify,
    openSheet,
    store,
    typing,
    uid,
} from "./store.js";
import { useDock } from "./dock.js";
import { defineItem, slotItems } from "./slots.js";
import { SubagentsBar } from "./subagents.js";
import { TrustBar } from "./trust.js";
import { prefs } from "./theme.js";
import { says } from "./turns.js";
import { MicButton, useDictation } from "./voice.js";
import {
    APPLE,
    contextLevel,
    formatBytes,
    formatTokens,
    html,
    Icon,
    Marked,
    modelLabel,
    Spinner,
} from "./ui.js";

/** The explicit route to the parent on every layout, outside the dock and the scrolling conversation. */
function ParentSessionButton() {
    const parent = store.state.view.conversation?.parent;

    if (!parent) {
        return null;
    }

    return html`<button
        class="parent-session"
        aria-label=${`Back to main session: ${parent.title}`}
        title=${`Return to ${parent.title}`}
        onClick=${() => navigate(parent.id)}
    >
        <${Icon} name="back" size=${16} />
        <span>Back to main session</span>
        <span class="parent-session-title">${parent.title}</span>
    </button>`;
}

const coarse = matchMedia("(pointer: coarse)").matches;
/**
 * A session opened by an Alt shortcut on an Apple keyboard, whose message box leaves the focus where it is: Option types
 * characters in a box, where the app's Alt shortcuts do nothing, so the next Alt+1…9 would type ™ there instead.
 */
let openedByAlt = null;

export const openingByAlt = (id) => (openedByAlt = APPLE ? id : null);
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

/**
 * The subagents a waiting message carries reports from (`extensions/subagents.ts`), as the server reads them from its
 * whole text: the queue gets only the start. Null for any other message, such as a person's, which has who sent it.
 */
const queuedReports = (item) => item.reports ?? null;

/** How a message can go while Pi works: the value the server takes, its label, and what it does. */
const SEND_MODES = [
    ["steer", "Steer", "Pi reads it now, between steps"],
    ["followUp", "Queue", "Pi reads it when this run ends"],
    ["interrupt", "Interrupt", "Stops the run right now (also its tool call), then sends it"],
];

/** What kind of message waits for Pi: a steer, one queued for after its answer, a note, or subagents' reports. */
function queuedMode(item) {
    const names = queuedReports(item);

    if (names) {
        return names.length === 1 ? "Report" : "Reports";
    }

    return item.mode === "steer" ? "Steer" : item.mode === "followUp" ? "Queue" : "Note";
}

/** Who sent a message, as the server writes it at the start when several people use Pi (`FROM_PREFIX`). */
const FROM = /^\[from: [^\]\n]{1,60}\] /;

/** What a waiting message says (its row names who sent it); subagents' reports say whose, as their text is long. */
function queuedText(item) {
    const names = queuedReports(item);

    if (!names) {
        return (item.text ?? "").replace(FROM, "");
    }

    return `from ${names.join(", ")}, on ${names.length === 1 ? "its" : "their"} way to Pi`;
}

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
            <span class="driver-label"><${Icon} name="wheel" size=${14} /> You're driving</span>
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
            <${Icon} name="wheel" size=${14} />
            ${turns.driver === undefined ? "No one is driving" : `${name(turns.driver)} is driving${driverHere ? "" : " (away)"}`}
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
    // There is a plan to approve once Pi has answered since plan mode went on.
    const proposed =
        view.plan.at === undefined ||
        [...view.entries.values()].some(
            (entry) =>
                entry.kind === "assistant" &&
                entry.at > view.plan.at &&
                entry.stopReason !== "toolUse" &&
                entry.blocks.some(says),
        );

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
                disabled=${view.live.busy || !proposed}
                title=${proposed ? undefined : "Pi has not proposed a plan yet."}
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

/** How a watch's last look found the PR's checks, and why a watch ended. */
const WATCH_CHECKS = {
    pending: "checks running",
    passed: "checks pass",
    failed: "checks failed",
};

function watchEnded(watch) {
    switch (watch.status) {
        case "merged":
            return "was merged.";
        case "closed":
            return "was closed.";
        case "gave-up":
            return `had more to tell than ${watch.max} messages: watch stopped.`;
        case "expired":
            return "had nothing new for two weeks: watch stopped.";
        default:
            return `could not be watched: ${watch.note ?? "something went wrong"}.`;
    }
}

/** A PR watch: which PR, its checks, what it sent Pi; stop it, or dismiss one that ended. */
function WatchBar() {
    const { watch } = store.state.view;

    if (!watch) {
        return null;
    }

    const pr = html`<a href=${watch.url} target="_blank" rel="noopener">PR #${watch.number}</a>`;
    const checks = WATCH_CHECKS[watch.checks];
    const text =
        watch.status === "watching"
            ? html`<strong>Watching</strong> ${pr}${checks ? ` · ${checks}` : ""}${watch.sent > 0 ? ` · ${watch.sent} of ${watch.max} sent` : ""}${watch.unchecked ? " · owner's comments only" : ""}${watch.errors > 0 ? " · last look failed" : watch.note ? " · waiting" : ""}`
            : html`${pr} ${watchEnded(watch)}`;

    return html`<div
        class=${`watch-bar ${watch.status}`}
        title=${[
            watch.title,
            watch.unchecked &&
                "Only the repository owner's comments count: gh cannot push there, so GitHub does not say who else can write.",
            watch.note,
        ]
            .filter(Boolean)
            .join("\n")}
    >
        <span class="grow">${text}</span>
        ${
            canSteer() &&
            html`<button class="link small" onClick=${() => attempt(actions.unwatchPr)}>
                ${watch.status === "watching" ? "Stop" : "Dismiss"}
            </button>`
        }
    </div>`;
}

export function Composer() {
    const { view, conversationId } = store.state;
    const historyScope = { person: store.state.me?.id, conversation: conversationId };
    const [text, setText] = useState(() => drafts.get(conversationId));
    const [files, setFiles] = useState([]);
    // How a message goes while Pi works: "steer", "followUp" (Queue), or "interrupt" (stop the run, then send).
    const [sendMode, setSendMode] = useState("steer");
    // The queued message tapped open, wrapped: one line each until then. The queue holds only a message's start.
    const [reading, setReading] = useState(null);
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
    // The box as it comes and goes (taking the wheel shows it, with the draft in it): fitted to its text at once, and
    // again when its width changes, which can come after the window's resize (the Peek column becoming a strip).
    const [setBox] = useState(() => {
        let width = -1;
        // A new width only (fitting changes the box's height, which this hears too), fitted a frame later.
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width !== width) {
                width = entry.contentRect.width;
                requestAnimationFrame(() => fitBox(box.current));
            }
        });

        return (element) => {
            box.current = element;
            fitBox(element);
            observer.disconnect();
            width = -1;

            if (element) {
                observer.observe(element);
            }
        };
    });
    // Dictation writes into the box as typing does, so the draft keeps what was heard.
    const dictation = useDictation(box, (value, at) => {
        setBrowsing(null);
        update(value, at);
    });
    // What is above the message box, and how it shares the room with the conversation (`dock.js`).
    const dock = useRef(null);
    const picker = useRef(null);
    const list = useRef(null);
    // One per `!` command: sending it again after a lost reply runs it once.
    const requestId = useRef(uid());
    // An extension's command while its send is unresolved: sending the same text again finds the first run.
    const commandRequest = useRef(null);
    const busy = view.live.busy;
    const agent = view.agent;

    // An Interrupt is for the run it was chosen in: when Pi stops working, an unused one goes back to Steer, so it does
    // not stop the next run. Steer and Queue stay as the person chose.
    useEffect(() => {
        if (!busy) {
            setSendMode((mode) => (mode === "interrupt" ? "steer" : mode));
        }
    }, [busy]);
    useEffect(() => {
        const draft = drafts.get(conversationId);

        dictation.stop(true);
        setText(draft);
        setCaret(draft.length);
        setPastes(loadPastes(conversationId));
        setBrowsing(null);
        setSearching(false);
    }, [conversationId]);
    // A session opens with the caret in its message box, ready to type: not on a touch screen, where the keyboard would
    // come up over the conversation, nor after an Alt shortcut on an Apple keyboard (`openingByAlt`), nor while another
    // text field has the focus (the docked chat a mention opened, the session search): words typed there stay there.
    useEffect(() => {
        const byAlt = openedByAlt === conversationId;
        const active = document.activeElement;
        const typingElsewhere =
            active instanceof HTMLElement &&
            active !== box.current &&
            (active.isContentEditable || /^(INPUT|TEXTAREA)$/.test(active.tagName));

        openedByAlt = null;

        if (!coarse && !byAlt && !typingElsewhere) {
            box.current?.focus({ preventScroll: true });
        }
    }, []);
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
        const fit = () => fitBox(box.current);

        fit();
        addEventListener("resize", fit);

        return () => removeEventListener("resize", fit);
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
            loadTemplates();
        }

        // A command is not a message to Pi: no "typing to Pi" for it.
        typing(value.trim() === "" || value.startsWith("/") ? null : "pi");
    };

    // Ctrl+R: what was sent before that has the words in the box.
    const recalled = searching ? searchHistory(text, historyScope) : [];
    const chosenRecall = recalled[Math.min(pick, recalled.length - 1)];
    const suggestions = hideCommands || searching ? [] : suggestCommands(text);
    const chosen = suggestions[Math.min(pick, suggestions.length - 1)];
    const parsed = parseCommand(text);
    const template = parsed ? null : parseTemplate(text);
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
    const runCommand = async ({ command, arg }, sent) => {
        let request = null;

        if (command.extension) {
            const kept = commandRequest.current;

            request =
                kept?.commandId === command.id &&
                kept.text === sent &&
                kept.conversationId === conversationId
                    ? kept
                    : { requestId: uid(), commandId: command.id, text: sent, conversationId };
            commandRequest.current = request;
        }

        setSending(true);
        const ok = await attempt(async () => {
            try {
                await command.run(arg, request?.requestId);
            } catch (error) {
                // A 4xx made no run, or refused it for good: the next send is a new request. After a network error
                // or a 5xx, the run may be there: the same send finds it.
                if (error.status >= 400 && error.status < 500) {
                    commandRequest.current = null;
                }

                throw error;
            }

            return true;
        });

        setSending(false);

        if (ok) {
            commandRequest.current = null;
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
        if (command.args || command.template) {
            update(`/${command.name} `);
            focusEnd();
        } else {
            runCommand({ command, arg: "" }, `/${command.name}`);
        }
    };

    const forget = (list) => {
        for (const file of list) {
            if (file.preview) {
                URL.revokeObjectURL(file.preview);
            }
        }
    };

    // Something in the box: on a phone while Pi works, Send takes the mic's place (style.css).
    const filled = text.trim() !== "" || files.length > 0;
    const uploading = files.some((file) => file.state === "uploading");
    const canSend =
        !sending &&
        !uploading &&
        (text.trim() !== "" || files.some((file) => file.state === "done"));

    /** What went out stays for ↑; its pastes are done with. */
    const sent = (full) => {
        if (full.length <= REMEMBER_CHARS) {
            remember(full, historyScope);
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
        if (!canSend) {
            return;
        }

        // What shows is what goes: words still coming would land in the emptied box.
        dictation.stop(true);
        const full = expandPastes(text, pastes);

        if (parsed) {
            if (full.length <= REMEMBER_CHARS) {
                remember(full, historyScope);
            }

            return runCommand(parseCommand(full) ?? parsed, full);
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
                busy ? sendMode : "followUp",
                inlineFiles && mentionsFiles,
            ),
        );

        setSending(false);

        if (ok) {
            // Interrupting stops the run: do not let the next message stop one by habit.
            if (sendMode === "interrupt") {
                setSendMode("steer");
            }

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

        const list = sentHistory(historyScope);

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

    const placeholder = dictation.listening
        ? "Listening…"
        : busy
          ? sendMode === "steer"
              ? "Steer the current run…"
              : sendMode === "interrupt"
                ? "Stop the run and send this now…"
                : "Queue a message for after this run…"
          : "Ask Pi anything…";
    const inbox = view.inbox ?? [];
    const { me, users } = store.state;
    const queuedBy = (item) =>
        item.by === undefined
            ? ""
            : item.by === me?.id
              ? " · you"
              : ` · ${users.find((user) => user.id === item.by)?.name ?? "someone"}`;

    useDock(dock);
    // View only now, or someone else took the wheel: the box goes, and dictation with it.
    const writes = !collab() || (canSteer() && !(view.turns?.on && view.turns.driver !== me?.id));

    useEffect(() => {
        if (!writes) {
            dictation.stop(true);
        }
    }, [writes]);

    if (collab() && !canSteer()) {
        return html`<footer class="composer-wrap" data-part="composer">
            <div class="dock" data-part="dock" ref=${dock}>
                <${TypingLine} where="pi" />
                <${SubagentsBar} />
            </div>
            <${ParentSessionButton} />
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

    const turns = view.turns;
    const blocked = collab() && turns?.on && turns.driver !== me?.id;
    const level =
        agent?.thinkingLevel && agent.thinkingLevel !== "off" && agent.reasoning
            ? agent.thinkingLevel
            : null;

    return html`<footer class="composer-wrap" data-part="composer">
        <div class="dock" data-part="dock" ref=${dock}>
            <${TypingLine} where="pi" />
            ${
                // How many wait: shown when the queue does not show them all (`dock.js`).
                inbox.length > 0 &&
                html`<div class="inbox-count">
                    ${inbox.length} ${inbox.length === 1 ? "message" : "messages"} waiting for Pi
                </div>`
            }
            ${
                inbox.length > 0 &&
                html`<div class="inbox">
                    ${inbox.map(
                        (item) => html`<div class="queued">
                            <span class="queued-mode">
                                ${queuedMode(item)}
                                <span class="muted">${queuedBy(item)}</span>
                            </span>
                            <button
                                class=${`queued-text ${reading === item.id ? "open" : ""}`}
                                aria-expanded=${reading === item.id}
                                onClick=${() => setReading(reading === item.id ? null : item.id)}
                            >
                                ${queuedText(item)}
                            </button>
                            ${
                                canSteer() &&
                                (!blocked || item.by === me?.id) &&
                                html`<button
                                    class="icon-button small queued-remove"
                                    aria-label=${queuedReports(item) ? "Discard these reports" : "Withdraw"}
                                    title=${queuedReports(item) ? "Discard these reports: Pi will not get them" : "Withdraw"}
                                    onClick=${() => attempt(() => actions.withdraw(item.id))}
                                >
                                    <${Icon} name="close" size=${13} />
                                </button>`
                            }
                        </div>`,
                    )}
                </div>`
            }
            ${collab() && html`<${DriverBar} />`}
            <${PlanBar} blocked=${blocked} />
            <${GoalBar} />
            <${WatchBar} />
            <${SubagentsBar} />
            <${TrustBar} />
        </div>
        <${ParentSessionButton} />
        ${
            blocked
                ? html`${
                      busy &&
                      html`<div class="composer-row stop-only">
                          <span class="muted small grow">Pi is working…</span>
                          <${StopButton} />
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
                              Sent in this session${text.trim() ? ` with “${text.trim()}”` : ""} · Enter puts it in the box · Esc closes
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
                                  Nothing you sent from this browser in this session matches.
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
                    class=${`composer ${busy ? "busy" : ""} ${filled ? "filled" : ""}`}
                    data-part="message-box"
                    onClick=${(event) => {
                        // The box is one target: a tap on its edge, around the files sent along, between its buttons,
                        // or on Send with nothing to send (a disabled button takes no taps), goes to the text.
                        if (
                            event.target === event.currentTarget ||
                            event.target.classList.contains("composer-row") ||
                            event.target.classList.contains("files")
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
                                    ${file.state === "uploading" ? html`<${Spinner} />` : file.preview ? "" : html`<${Icon} name="clip" size=${13} />`}
                                    <span class="chip-name" title=${file.name}>${file.name}</span>
                                    <span class="muted">${formatBytes(file.size)}</span>
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
                        ref=${setBox}
                        rows="1"
                        value=${text}
                        placeholder=${placeholder}
                        onInput=${(event) => {
                            setBrowsing(null);
                            update(event.currentTarget.value, event.currentTarget.selectionStart);
                        }}
                        onKeyDown=${onKey}
                        onKeyUp=${(event) => setCaret(event.currentTarget.selectionStart)}
                        onClick=${(event) => setCaret(event.currentTarget.selectionStart)}
                        onFocus=${() => loadFiles({ ifMissing: true })}
                        onPaste=${onPaste}
                        enterkeyhint=${coarse ? "enter" : "send"}
                    ></textarea>
                    <div class="composer-row" data-part="composer-tools">
                        ${slotItems("composer", { picker, agent, level, view }).map(({ node }) => node)}
                        <input
                            ref=${picker}
                            type="file"
                            multiple
                            hidden
                            onChange=${(event) => {
                                addFiles([...event.currentTarget.files]);
                                event.currentTarget.value = "";
                            }}
                        />
                        <span class="grow"></span>
                        ${
                            busy &&
                            html`<div
                                class="mode-switch"
                                data-part="composer-button mode-switch"
                                role="radiogroup"
                                aria-label="Send as"
                                onKeyDown=${(event) => {
                                    // Arrows move between them, as in any group of radio buttons.
                                    if (/^Arrow(Left|Right|Up|Down)$/.test(event.key)) {
                                        const group = event.currentTarget;
                                        const modes = SEND_MODES.map(([value]) => value);
                                        const step = /^Arrow(Left|Up)$/.test(event.key) ? -1 : 1;

                                        event.preventDefault();
                                        setSendMode(
                                            modes[
                                                (modes.indexOf(sendMode) + step + modes.length) %
                                                    modes.length
                                            ],
                                        );
                                        requestAnimationFrame(() =>
                                            group.querySelector('[aria-checked="true"]')?.focus(),
                                        );
                                    }
                                }}
                            >
                                ${SEND_MODES.map(
                                    ([value, label, tip]) => html`<button
                                        role="radio"
                                        aria-checked=${sendMode === value ? "true" : "false"}
                                        tabindex=${sendMode === value ? "0" : "-1"}
                                        class=${`${sendMode === value ? "on" : ""} ${value === "interrupt" ? "interrupt" : ""}`}
                                        title=${tip}
                                        onMouseDown=${(event) => event.preventDefault()}
                                        onClick=${() => setSendMode(value)}
                                    >
                                        ${label}
                                    </button>`,
                                )}
                            </div>`
                        }
                        <${MicButton}
                            dictation=${dictation}
                            class="composer-mic"
                            part="composer-button"
                        />
                        <button
                            class=${`send-button ${canSend ? "ready" : ""}`}
                            data-part="send-button"
                            data-state=${canSend ? "ready" : undefined}
                            aria-label="Send"
                            title=${coarse ? "Send" : "Send (Enter)"}
                            disabled=${!canSend}
                            onClick=${send}
                        >
                            ${
                                sending
                                    ? html`<${Spinner} />`
                                    : html`<${Icon} name="send" size=${16} stroke=${2.4} />`
                            }
                        </button>
                        ${busy && html`<${StopButton} />`}
                    </div>
                </div>`
        }
        <${StatusLine} />
    </footer>`;
}

// The buttons on the left of the message box's row: the app's own items of the `composer` slot (slots.js), which a
// person can hide and reorder in Appearance, with extensions' after them. Each gets what the box knows: its file
// picker, the model and thinking level, and the session's view. Send, Stop, the mic, and Steer and Queue stay on the
// right, always.
defineItem("composer", {
    id: "core:places",
    label: "Places (phones)",
    order: 100,
    render: () => html`<${PlacesButton} />`,
});
defineItem("composer", {
    id: "core:attach",
    label: "Attach files",
    order: 200,
    render: ({ picker }) =>
        html`<button
            class="icon-button attach-button"
            data-part="composer-button"
            aria-label="Attach files"
            title="Attach files"
            onClick=${() => picker.current?.click()}
        >
            <${Icon} name="clip" size=${17} />
        </button>`,
});
defineItem("composer", {
    id: "core:model",
    label: "Model",
    order: 300,
    render: ({ agent, level }) =>
        html`<button
            class=${`model-chip ${agent?.available === false ? "warn" : ""}`}
            data-part="model-chip"
            aria-label=${`Model: ${modelLabel(agent)}${level ? `, thinking ${level}` : ""}`}
            title=${`Model and thinking: ${modelLabel(agent)}${level ? `, ${level}` : ""}`}
            onClick=${() => openSheet({ type: "model" })}
        >
            <${Icon} name="sparkle" size=${12} class="model-spark" />
            <span class="model-name">${shortModel(agent)}</span>
            ${level && html`<span class="model-level">${level}</span>`}
            <${Icon} name="chevron" size=${12} stroke=${2.2} class="model-caret" />
        </button>`,
});
defineItem("composer", {
    id: "core:plan",
    label: "Plan",
    order: 400,
    render: ({ view }) =>
        planAvailable() &&
        view.conversation?.kind !== "subagent" &&
        html`<button
            class=${`plan-chip ${view.plan?.on ? "on" : ""}`}
            data-part="composer-button plan-chip"
            aria-pressed=${view.plan?.on === true}
            title="Plan mode: Pi reads and proposes, and changes nothing until you approve"
            onMouseDown=${(event) => event.preventDefault()}
            onClick=${() => attempt(() => actions.setPlan(!view.plan?.on))}
        >
            Plan
        </button>`,
});

/**
 * The message box grows with what is written, to 40% of the screen; its least height (two lines, or one on a short
 * screen) is the stylesheet's, and changes with the screen.
 */
function fitBox(element) {
    if (!element) {
        return;
    }

    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, innerHeight * 0.4)}px`;
}

/** A model's short name for the message box: "opus 4.5" for "Claude Opus 4.5". */
const shortModel = (agent) =>
    modelLabel(agent)
        // A provider's own prefix ("Anthropic: Claude Opus 4.5"), then the family's name.
        .replace(/^[^:]{1,24}:\s*/, "")
        .replace(/^(?:anthropic\s+)?claude\s+/i, "")
        .toLowerCase();

/** Stop the run: a square in the failure color. */
function StopButton() {
    return html`<button
        class="stop-button"
        data-part="composer-button stop-button"
        aria-label="Stop"
        title="Stop (Esc twice)"
        onClick=${() => attempt(actions.abort)}
    >
        <span class="stop-square" aria-hidden="true"></span>
    </button>`;
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
        data-part="composer-button"
        aria-label="Places: Files, Changes, Browser, and more"
        title="Places (or swipe up here)"
        onClick=${() => openSheet({ type: "places" })}
    >
        <${Icon} name="grid" />
        ${news && html`<span class="browser-dot" aria-hidden="true"></span>`}
    </button>`;
}

/**
 * The status line's shorter forms, in the order a narrow line takes them until it fits on one row: shorter words and
 * gaps, no "1 here" while you are alone, extensions' items' short forms, the guard's and the context's labels, then the
 * cache, then the wait for the first token.
 */
const SHORTER = ["words", "here", "ext", "guard", "context", "cache", "wait"];
/** What each status line was last fitted for: its text. Its width is the observer's to watch. */
const fitted = new WeakMap();

/** Whether the items that show sit on one row: their middles line up. */
function oneRow(line) {
    const middles = [...line.children]
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => box.top + box.height / 2);

    return middles.every((middle) => Math.abs(middle - middles[0]) < 2);
}

/**
 * The whole line where it fits on one row; otherwise each shorter form in turn, until one does. Only when its text
 * changed, or `again`: a render that changed nothing measures nothing.
 */
function fitStatus(line, again = false) {
    if (!line) {
        return;
    }

    const key = line.textContent;

    // Hidden, it has no width to fit: the observer hears it show.
    if ((!again && fitted.get(line) === key) || line.clientWidth === 0) {
        return;
    }

    fitted.set(line, key);

    for (let step = 0; step <= SHORTER.length; step++) {
        line.dataset.short = SHORTER.slice(0, step).join(" ");

        if (oneRow(line)) {
            return;
        }
    }
}

/** Keep the status line in `ref` on one row: after every render, when its width changes, and once the font loads. */
function useStatusFit(ref) {
    useLayoutEffect(() => fitStatus(ref.current));
    useEffect(() => {
        const line = ref.current;

        if (!line) {
            return;
        }

        let frame = 0;
        let gone = false;
        let width = -1;
        // A new width only (fitting changes the line's height, which this hears too), fitted a frame later.
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === width) {
                return;
            }

            width = entry.contentRect.width;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => fitStatus(line, true));
        });

        observer.observe(line);
        document.fonts?.ready.then(() => !gone && fitStatus(line, true));

        return () => {
            gone = true;
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, []);
}

/** Seconds, as the status line says them: 0.4s, 3.2s, 14s. */
const seconds = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/**
 * How fast the newest answer came, once Appearance turns it on: its tokens a second, and how long its first token
 * took. Narrow, "42 tok/s · 1.2s"; an answer that came in one flush has no speed, only its wait.
 */
function SpeedPart({ stats }) {
    const rate = stats.tokensPerSec;
    const wait = stats.ttftMs;

    if (rate === undefined && wait === undefined) {
        return null;
    }

    const title = [
        rate !== undefined && `${rate.toFixed(1)} tokens a second`,
        wait !== undefined && `its first token after ${(wait / 1000).toFixed(2)}s`,
    ]
        .filter(Boolean)
        .join(", ");

    return html`<span
        class=${`speed ${rate === undefined ? "wait-only" : ""}`}
        title=${`How fast the last answer came: ${title}`}
    >
        ${
            rate !== undefined &&
            html`<span class="rate">
                <span class="num">${rate < 9.95 ? rate.toFixed(1) : Math.round(rate)}</span>${" "}
                <span class="long">tokens/s</span>
                <span class="short">tok/s</span>
            </span>`
        }
        ${
            wait !== undefined &&
            html`<span class="wait">
                <span class="word">first token${" "}</span>
                <span class="num">${seconds(wait)}</span>
            </span>`
        }
    </span>`;
}

// The status line's items: the app's own items of the `status` slot (slots.js), which a person can hide and reorder in
// Appearance, with extensions' before the spend. The connection's warning leads and Lancet Guard ends it, always.
defineItem("status", {
    id: "core:connection",
    label: "Connection",
    order: 0,
    fixed: true,
    render() {
        const { connection } = store.state;

        return (
            connection !== "open" &&
            html`<span class="warn">
                ${connection === "connecting" ? "connecting…" : "reconnecting…"}
            </span>`
        );
    },
});
defineItem("status", {
    id: "core:here",
    label: "People here",
    order: 100,
    render() {
        const { view, presence } = store.state;
        // People, not tabs: one person with a phone and a laptop open is one here (presence has a row per person).
        const here = presence.length || view.viewers?.length || 1;

        return html`<span
            class=${`here ${here === 1 ? "alone" : ""}`}
            title=${`${(view.viewers ?? []).join(", ")}${view.clients > here ? ` · ${view.clients} tabs` : ""}`}
        >
            ${here} here
        </span>`;
    },
});
defineItem("status", {
    id: "core:speed",
    label: "Reply speed",
    order: 200,
    render: () =>
        prefs().speed === true && html`<${SpeedPart} stats=${store.state.view.stats ?? {}} />`,
});

/** How full the context is: `{ used, window, percent, about }`, or null with no context window known. */
function contextFill() {
    const { view } = store.state;
    const window = view.agent?.contextWindow;

    if (!window) {
        return null;
    }

    const used = view.stats?.contextTokens ?? 0;

    return {
        used,
        window,
        percent: Math.min(100, Math.round((used / window) * 100)),
        // Compacted since the last answer: what is left, estimated until the next answer measures it.
        about: view.stats?.contextEstimated ? "~" : "",
    };
}

const contextTitle = ({ used, window, about }) =>
    `${about}${formatTokens(used)} of ${formatTokens(window)} tokens in context`;

defineItem("status", {
    id: "core:context",
    label: "Context",
    order: 300,
    render() {
        const fill = contextFill();

        return (
            fill &&
            html`<span class="context" title=${contextTitle(fill)}>
                <span class="word">context</span>
                <span class=${`meter ${contextLevel(fill.percent)}`} aria-hidden="true">
                    <span style=${`width:${fill.percent}%`}></span>
                </span>
                <span class="num">${fill.about}${fill.percent}%</span>
            </span>`
        );
    },
    detail() {
        const fill = contextFill();

        return fill && contextTitle(fill);
    },
});

const cacheRate = () => store.state.view.stats?.cacheRate;

defineItem("status", {
    id: "core:cache",
    label: "Cache",
    order: 400,
    render: () =>
        cacheRate() !== undefined &&
        html`<span class="cache">
            cache <span class="num">${Math.round(cacheRate() * 100)}%</span>
        </span>`,
    detail: () =>
        cacheRate() !== undefined &&
        `${Math.round(cacheRate() * 100)}% of the input came from the cache`,
});

/**
 * The session's spend, its subagents' included, and its limit; with a limit on a session that started others, the
 * team's spend, which is what counts against it.
 */
function spendNow() {
    const { view } = store.state;
    const spend = view.conversation?.spend;

    return { spent: spend?.spent ?? view.stats?.cost ?? 0, budget: spend?.budget };
}

defineItem("status", {
    id: "core:spend",
    label: "Spend",
    order: 600,
    render() {
        const { spent, budget } = spendNow();

        return html`<span class=${budget !== undefined && spent >= budget ? "warn" : ""}>
            <span class="num">
                $${spent.toFixed(2)} ${budget !== undefined ? `/$${budget.toFixed(2)}` : ""}
            </span>
        </span>`;
    },
    detail() {
        const { spent, budget } = spendNow();

        return `$${spent.toFixed(2)} spent${budget !== undefined ? ` of $${budget.toFixed(2)}` : ""}`;
    },
});
defineItem("status", {
    id: "core:guard",
    label: "Lancet Guard",
    order: 700,
    fixed: true,
    render() {
        const { guard } = store.state;
        // On but not loaded: the guard blocks bash, write, and edit until it loads or is turned off.
        const failed = guard?.enabled && guard.available === false;

        if (!guard?.enabled && !guard?.available) {
            return null;
        }

        const state = failed ? "failed" : guard.enabled ? "on" : "off";

        return html`<button
            class=${`guard ${guard.enabled && !failed ? "" : "off"}`}
            aria-label=${`Lancet Guard ${state}`}
            title=${guard.detail}
            onClick=${() => openSheet({ type: "extensions", tab: "installed" })}
        >
            <${Icon} name="shield" size=${11} />
            <span><span class="word">guard${" "}</span>${state}</span>
        </button>`;
    },
});

/** Under the message box: the `status` slot's items, on one row: a narrow one takes shorter forms (`SHORTER`). */
function StatusLine() {
    const line = useRef(null);
    const items = slotItems("status");
    const parts = items.map(({ node }) => node);
    // What each item says, for a tap on the line: a touch screen shows no tooltips.
    const details = items.map(({ detail }) => detail).filter(Boolean);

    useStatusFit(line);

    // A tap on the line says what it shows (the guard's pill has its own); with a mouse, the tooltips do.
    const explain = (event) => {
        if (coarse && !event.target.closest("button")) {
            notify("info", details.join(" · "));
        }
    };

    return html`<div class="status-line" data-part="status-line" ref=${line} onClick=${explain}>
        ${parts}
    </div>`;
}
