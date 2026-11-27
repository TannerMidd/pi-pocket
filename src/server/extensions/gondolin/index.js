// Gondolin sandbox's browser module: a status item on a sandboxed session, a Sandbox row in the session menu, and one
// sheet that says what the sandbox is, what runs where, who chose it, and (for the owner) what this machine has and
// how to set it up. It uses only `pocket` and the module's own routes.
export const pocketApi = 2;

const WHERE = {
    sandbox: "In the sandbox",
    host: "On this machine",
    blocked: "Blocked",
};

const PHASES = {
    starting: "starting",
    running: "running",
    stopped: "idle",
    error: "could not start",
};

function size(mb) {
    return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** A VM's size in words. It is a string, so the layout of the markup cannot take a space out of it. */
function sizeText({ cpus, memoryMb }) {
    return `${cpus} CPUs, ${size(memoryMb)} of memory`;
}

function allowedText(count) {
    return `Only the ${count} allowed hosts`;
}

function runningText(host) {
    return `${host.running} of ${host.max} VM${host.max === 1 ? "" : "s"} running.`;
}

/** Running text of the sheet, each as one string: a line break inside the text of an `html` template is no space. */
const SWITCH_NOTE =
    "Pi's file and shell tools, your ! commands and the browser run in a Linux virtual machine. Only this session's folder is shared with it. It starts at the first call, and stops when it is idle.";
const STALE_NOTE =
    "This VM keeps the rules it started with. The new settings apply when it starts again.";
const NO_SESSION_NOTE =
    "Open a session to choose whether its tools run in a sandbox. Set up below works without one.";
const NOT_SET_UP_NOTE =
    "The sandbox is not set up yet. Tap Set up: it installs the Gondolin package and downloads the guest image. Nothing is installed outside Pi Pocket's data folder.";
const REMOVE_NOTE =
    "This stops every sandbox VM and deletes the package and the images. Sessions keep their sandbox setting and fail until you set up again.";

/** What Set up does, in one string for the same reason. */
function setupText(host, browser) {
    const plain = host.estimate.plain;
    const withBrowser = host.estimate.browser;

    return browser
        ? `Installs the Gondolin package into the folder "gondolin" of the data folder, downloads the standard image, and builds an image with Chromium on this machine: ${withBrowser.download}, ${withBrowser.disk} on disk, ${withBrowser.time}.`
        : `Installs the Gondolin package into the folder "gondolin" of the data folder and downloads the guest image: ${plain.download}, ${plain.disk} on disk, ${plain.time}. Nothing is installed outside Pi Pocket's data folder.`;
}

export default function setup(pocket) {
    const { html, useEffect, useState, useCallback } = pocket;

    pocket.style("style.css");

    /** The session the tab shows, and what the server says of its sandbox. */
    let conversation = null;
    let state = null;
    let item = null;
    let row = null;
    let owner = false;
    let hostOk = null;
    const listeners = new Set();

    const notify = () => {
        for (const listener of listeners) {
            listener();
        }
    };

    const describe = () => {
        const vm = state?.vm;
        const phase = vm === null || vm === undefined ? "idle" : (PHASES[vm.phase] ?? vm.phase);

        return phase;
    };

    const draw = () => {
        if (state === null || state.session.on !== true) {
            item?.remove();
            item = null;
        } else {
            const phase = describe();
            const spec = {
                id: "sandbox",
                text: `Sandbox: ${phase}`,
                short: "Sandbox",
                title: "This session's file and shell tools run in a micro-VM. The browser too. Tap for what runs where.",
                tone:
                    state.vm?.phase === "error" ? "error" : phase === "idle" ? "muted" : undefined,
                sheet: "sandbox",
            };

            if (item === null) {
                item = pocket.status(spec);
            } else {
                item.update(spec);
            }
        }

        // The menu row is there for people who steer; the sheet says if they may choose.
        if (state === null) {
            row?.remove();
            row = null;
        } else if (row === null) {
            row = pocket.menu({
                id: "sandbox",
                label: "Sandbox",
                hint: "Run this session's tools in a micro-VM",
                group: "session",
                sheet: "sandbox",
            });
        }

        notify();
    };

    let loading = 0;

    const load = async () => {
        const mine = conversation;
        const ticket = ++loading;

        if (mine === null) {
            state = null;
            draw();

            return;
        }

        try {
            const answer = await pocket.api(`state?c=${mine}`);

            if (ticket === loading && conversation === mine) {
                state = answer;
                draw();
            }
        } catch {
            // A person who may not steer, or an older server: no sandbox here.
            if (ticket === loading && conversation === mine) {
                state = null;
                draw();
            }
        }
    };

    // The owner can set up the sandbox with no session open: a row in the app menu and a launcher action, and the
    // module's entry in the Extensions sheet lists the row. Others have no Set up, so they get no entry.
    pocket.api("owner").then(
        () => {
            owner = true;
            pocket.menu({
                id: "sandbox-setup",
                label: "Sandbox set up",
                hint: "Install Gondolin and see what this machine has",
                sheet: "sandbox",
            });
            pocket.launcher({
                id: "sandbox-setup",
                label: "Sandbox set up",
                detail: "install Gondolin, build the guest image, see what runs where",
                keywords: ["sandbox", "gondolin", "micro-vm", "setup", "set up"],
                sheet: "sandbox",
            });
            notify();
        },
        () => {
            // Not the owner, or an older server: no Set up for this person.
        },
    );

    pocket.onConversation((id) => {
        conversation = id;
        state = null;
        draw();
        void load();
    });
    pocket.on("changed", (data) => {
        if (data?.c === undefined || data.c === conversation) {
            void load();
        }
    });

    function useSandbox() {
        const [, tick] = useState(0);

        useEffect(() => {
            const again = () => tick((count) => count + 1);

            listeners.add(again);

            return () => listeners.delete(again);
        }, []);

        return { conversation, state, owner, hostOk };
    }

    function Switcher({ close }) {
        const { conversation: id, state: mine } = useSandbox();
        const [busy, setBusy] = useState(false);
        const [problem, setProblem] = useState(null);

        const toggle = useCallback(async () => {
            if (id === null || mine === null) {
                return;
            }

            setBusy(true);
            setProblem(null);

            try {
                await pocket.api("session", { c: id, on: !mine.session.on });
                await load();
            } catch (error) {
                setProblem(error.message);
            } finally {
                setBusy(false);
            }
        }, [id, mine]);

        if (id === null) {
            return html`<p class="muted small">${NO_SESSION_NOTE}</p>`;
        }

        if (mine === null) {
            return html`<p class="muted">The sandbox is not available for this session.</p>`;
        }

        const why = !mine.mayChoose
            ? "Only the owner chooses which sessions run in a sandbox. The owner can let people who steer choose, in Menu → Extensions → Gondolin sandbox."
            : !mine.session.on && mine.problem !== null
              ? mine.problem
              : null;

        return html`
            <div class="gdl-block">
                <div class="setting gdl-setting">
                    <span class="gdl-setting-label">Run this session's tools in a sandbox</span>
                    <${pocket.Switch}
                        on=${mine.session.on}
                        label="Run this session's tools in a sandbox"
                        onChange=${toggle}
                        disabled=${busy || (why !== null && !mine.session.on) || !mine.mayChoose}
                    />
                </div>
                ${why === null ? null : html`<p class="muted small">${why}</p>`}
                ${problem === null ? null : html`<div class="error-box">${problem}</div>`}
                ${mine.session.on ? html`<p class="muted small">${SWITCH_NOTE}</p>` : null}
            </div>
        `;
    }

    function Vm({ close }) {
        const { conversation: id, state: mine } = useSandbox();
        const [busy, setBusy] = useState(false);

        if (mine === null || mine.session.on !== true) {
            return null;
        }

        const vm = mine.vm;
        const network = vm?.network ?? mine.settings.network;
        const hosts = vm?.allowedHosts ?? mine.settings.allowedHosts;

        const stop = async () => {
            setBusy(true);

            try {
                await pocket.api("stop", { c: id });
                await load();
            } finally {
                setBusy(false);
            }
        };

        return html`
            <div class="gdl-block">
                <h3 class="gdl-h">This session's VM</h3>
                <dl class="gdl-facts">
                    <dt>State</dt>
                    <dd>
                        ${vm === null ? "Not started yet (it starts at the next call)" : describe()}
                    </dd>
                    ${
                        vm?.note
                            ? html`<dt>Last</dt>
                                  <dd>${vm.note}</dd>`
                            : null
                    }
                    <dt>Folder</dt>
                    <dd>
                        <span class="mono small">${vm?.cwd ?? "this session's folder"}</span>
                        <div class="muted small">
                            ${(vm?.mount ?? mine.settings.mount) === "ro" ? "Read only" : "Read and write"}
                        </div>
                    </dd>
                    <dt>Network</dt>
                    <dd>
                        ${
                            network === "off"
                                ? "None"
                                : network === "open"
                                  ? "Public hosts (never this machine or your local network)"
                                  : html`<div>${allowedText(hosts.length)}</div>
                                        <div class="muted small">${hosts.join(", ")}</div>`
                        }
                        ${
                            vm?.stale === true
                                ? html`<div class="muted small">${STALE_NOTE}</div>`
                                : null
                        }
                    </dd>
                    <dt>Size</dt>
                    <dd>${sizeText(vm ?? mine.settings)}</dd>
                </dl>
                ${
                    vm !== null && vm.phase === "running"
                        ? html`<button class="button" disabled=${busy} onClick=${stop}>
                              Stop the VM
                          </button>`
                        : null
                }
            </div>
        `;
    }

    function Where() {
        const { state: mine } = useSandbox();

        if (mine === null) {
            return null;
        }

        return html`
            <div class="gdl-block">
                <h3 class="gdl-h">What runs where</h3>
                <ul class="gdl-where">
                    ${mine.where.map(
                        (each) => html`
                            <li class=${`gdl-where-row gdl-${each.where}`}>
                                <div class="gdl-where-head">
                                    <span class="gdl-what">${each.what}</span>
                                    <strong class="gdl-where-label">${WHERE[each.where]}</strong>
                                </div>
                                <div class="muted small">${each.note}</div>
                            </li>
                        `,
                    )}
                </ul>
            </div>
        `;
    }

    function Host() {
        const { owner: admin } = useSandbox();
        const [host, setHost] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [sure, setSure] = useState(null);

        const refresh = useCallback(async () => {
            try {
                const answer = await pocket.api("host");

                hostOk = answer.check?.ok ?? null;
                setHost(answer);
                notify();
            } catch (failure) {
                setError(failure.message);
            }
        }, []);

        useEffect(() => {
            if (!admin) {
                return undefined;
            }

            void refresh();
            let timer;

            // A VM that starts, stops, or goes from idle to working changes the list too, not only the set-up.
            const soon = () => {
                clearTimeout(timer);
                timer = setTimeout(() => void refresh(), 150);
            };

            const stops = [
                pocket.on("setup", () => void refresh()),
                pocket.on("changed", soon),
                pocket.on("vms", soon),
            ];

            return () => {
                clearTimeout(timer);

                for (const stop of stops) {
                    stop();
                }
            };
        }, [admin, refresh]);

        if (!admin) {
            return null;
        }

        const act = async (path, body) => {
            setBusy(true);
            setError(null);
            setSure(null);

            try {
                await pocket.api(path, body ?? {});
                await refresh();
                await load();
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        };

        const running = host?.setup.running === true;
        const notReady = host?.check.ok === false;
        const checks =
            host === null
                ? null
                : html`
                      <ul class="gdl-check">
                          ${host.check.lines.map(
                              (line) => html`
                                  <li
                                      class=${line.ok ? "gdl-ok" : line.optional ? "gdl-info" : "gdl-bad"}
                                  >
                                      <strong
                                          >${line.ok ? "OK" : line.optional ? "Not used" : "Needs work"}</strong
                                      >
                                      <span class="gdl-line"
                                          ><b>${line.name}.</b> ${line.detail}</span
                                      >
                                  </li>
                              `,
                          )}
                      </ul>
                      <p class="muted small">${runningText(host)}</p>
                      ${
                          host.vms.length === 0
                              ? null
                              : html`<h3 class="gdl-h">Running sandboxes</h3>
                                    <ul class="gdl-vms">
                                        ${host.vms.map(
                                            (each) => html`
                                                <li class="gdl-vm">
                                                    <div class="gdl-vm-info">
                                                        <strong class="gdl-vm-title"
                                                            >${each.title || `Session ${each.rootId}`}</strong
                                                        >
                                                        <span class="mono small gdl-vm-folder"
                                                            >${each.cwd}</span
                                                        >
                                                        <span class="muted small"
                                                            >${each.busy > 0 ? "Working" : "Idle"}</span
                                                        >
                                                    </div>
                                                    <button
                                                        class="button"
                                                        disabled=${busy}
                                                        onClick=${() => act("stop-vm", { c: each.rootId })}
                                                    >
                                                        Stop
                                                    </button>
                                                </li>
                                            `,
                                        )}
                                    </ul>`
                      }
                  `;
        const actions =
            host === null
                ? null
                : html`
                      ${
                          running
                              ? html`
                                    <pre class="gdl-log mono small">
${host.setup.lines.join("\n")}</pre>
                                    <button class="button" onClick=${() => act("setup-stop")}>
                                        Stop Set up
                                    </button>
                                `
                              : html`
                                    ${
                                        host.setup.error === null
                                            ? host.setup.done
                                                ? html`<p class="muted small">Set up finished.</p>`
                                                : null
                                            : html`<div class="error-box">${host.setup.error}</div>`
                                    }
                                    <div class="gdl-actions">
                                        <button
                                            class="button"
                                            disabled=${busy}
                                            onClick=${() => act("check")}
                                        >
                                            Check again
                                        </button>
                                        <button
                                            class="button primary"
                                            disabled=${busy}
                                            onClick=${() => setSure("plain")}
                                        >
                                            Set up
                                        </button>
                                        <button
                                            class="button"
                                            disabled=${busy}
                                            onClick=${() => setSure("browser")}
                                        >
                                            Set up with a browser
                                        </button>
                                    </div>
                                    ${
                                        sure !== "plain" && sure !== "browser"
                                            ? null
                                            : html`
                                                  <div class="gdl-confirm">
                                                      <p>${setupText(host, sure === "browser")}</p>
                                                      <div class="gdl-actions">
                                                          <button
                                                              class="button primary"
                                                              disabled=${busy}
                                                              onClick=${() => act("setup", { browser: sure === "browser" })}
                                                          >
                                                              Start
                                                          </button>
                                                          <button
                                                              class="button"
                                                              onClick=${() => setSure(null)}
                                                          >
                                                              Not now
                                                          </button>
                                                      </div>
                                                  </div>
                                              `
                                    }
                                    <div class="gdl-actions">
                                        <button
                                            class="button"
                                            disabled=${busy}
                                            onClick=${() => setSure("remove")}
                                        >
                                            Remove the package and images
                                        </button>
                                    </div>
                                    ${
                                        sure === "remove"
                                            ? html`<div class="gdl-confirm">
                                                  <p>${REMOVE_NOTE}</p>
                                                  <div class="gdl-actions">
                                                      <button
                                                          class="button"
                                                          disabled=${busy}
                                                          onClick=${() => act("remove")}
                                                      >
                                                          Remove
                                                      </button>
                                                      <button
                                                          class="button"
                                                          onClick=${() => setSure(null)}
                                                      >
                                                          Not now
                                                      </button>
                                                  </div>
                                              </div>`
                                            : null
                                    }
                                `
                      }
                  `;

        return html`
            <div class="gdl-block">
                <h3 class="gdl-h">This machine</h3>
                ${error === null ? null : html`<div class="error-box">${error}</div>`}
                ${
                    host === null
                        ? html`<${pocket.Loader} />`
                        : notReady
                          ? [html`<p class="gdl-notready">${NOT_SET_UP_NOTE}</p>`, actions, checks]
                          : [checks, actions]
                }
            </div>
        `;
    }

    function SandboxSheet({ close }) {
        const { owner: admin, state: mine, hostOk: ready } = useSandbox();
        // Until the machine is set up, the owner sees Set up first: nothing above it, nothing to scroll to.
        const first = admin && (ready ?? mine?.ready ?? null) !== true;

        // Keyed, so Host keeps its state when it moves.
        const parts = [
            html`<${Switcher} key="switch" close=${close} />`,
            html`<${Vm} key="vm" close=${close} />`,
            html`<${Where} key="where" />`,
        ];
        const host = html`<${Host} key="host" />`;

        return html`<div class="gdl-sheet">${first ? [host, ...parts] : [...parts, host]}</div>`;
    }

    pocket.sheet({ id: "sandbox", title: "Sandbox", component: SandboxSheet });
}
