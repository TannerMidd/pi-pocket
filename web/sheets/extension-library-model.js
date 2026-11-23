// Only group modules the server actually lists. New built-ins and drop-ins need no catalog entry.
const GROUPS = {
    "Agents & automation": {
        "agent-teams": ["fork", "Delegate to linked sessions."],
        subagents: ["users", "Hand off a focused piece of work."],
        schedules: ["clock", "Send a message later or on repeat."],
        "run-outcomes": ["check", "Label a finished run’s report."],
        background: ["terminal", "Run and monitor background commands."],
        triggers: ["pulse", "Watch for changes and notify Pi."],
        goals: ["check", "Set a condition for finishing work."],
    },
    Communication: {
        "pocket-relay": ["send", "Connect conversations to chat services."],
        "relay-triage": ["shield", "Screen inbound messages and replies."],
        ask: ["chat", "Ask a question in the conversation."],
        "ask-someone": ["reply", "Draft a question for someone outside the chat."],
        surfaces: ["tiles", "Show interactive cards in a conversation."],
        pip: ["pip", "Follow work with your personal assistant."],
    },
    Workspace: {
        guard: ["shield", "Check risky tool calls before they run."],
        plan: ["eye", "Explore a plan without changing files."],
        memory: ["pin", "Keep lessons across sessions."],
        browser: ["globe", "Open and inspect pages with Pi."],
        "session-tags": ["star", "Organize sessions with shared labels."],
        "session-cleanup": ["archive", "Clean up archived sessions and their worktrees."],
    },
    "Creation & display": {
        artifacts: ["artifact", "Publish pages, slides and other artifacts."],
        design: ["palette", "Design and check screens in the canvas."],
        diagrams: ["grid", "Render diagrams and math in the conversation."],
    },
    "Tools & system": {
        codemode: ["terminal", "Combine tool calls in JavaScript."],
        "tool-search": ["search", "Find tools when a task needs them."],
        prompt: ["chat", "Provide Pi’s system instructions."],
        "jev-hub": ["pulse", "Inspect recent classifier activity."],
        gallery: ["grid", "Find extensions and themes."],
        updates: ["download", "Check for new versions of Pi Pocket."],
        "anthropic-subscription": ["key", "Use Claude subscription billing."],
    },
};

const catalog = new Map(
    Object.entries(GROUPS).flatMap(([group, entries]) =>
        Object.entries(entries).map(([name, [icon, line]]) => [
            `${name}.ts`,
            { group, icon, line },
        ]),
    ),
);

const order = new Map([...catalog.keys()].map((file, index) => [file, index]));

export const groupOrder = [...Object.keys(GROUPS), "Other features", "Added extensions"];
const metadata = (module) => module?.source === "built-in" && catalog.get(module.file);

export const iconOf = (module) => metadata(module)?.icon ?? "grid";
export const stateOf = (module) => (module.required ? "Always on" : module.enabled ? "On" : "Off");
export const groupOf = (module) =>
    module?.source !== "built-in"
        ? "Added extensions"
        : (metadata(module)?.group ?? "Other features");

export function summaryOf(module) {
    const title = module.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = (module.summary ?? "").replace(new RegExp(`^(the )?${title}: `, "i"), "");

    return line.charAt(0).toUpperCase() + line.slice(1);
}

export function libraryRows(modules, installed = [], entries = []) {
    const byFile = new Map(modules.map((module) => [module.file, { module }]));
    const offers = new Map(entries.map((entry) => [entry.name, entry]));

    for (const item of installed) {
        if (item.kind !== "theme") {
            const row = byFile.get(item.file) ?? {};

            byFile.set(item.file, { ...row, installed: item, entry: offers.get(item.name) });
        }
    }

    const rows = [...byFile].map(([file, { module, installed: item, entry }]) => ({
        file,
        module,
        installed: item,
        group: groupOf(module),
        title: item?.title ?? module.title,
        line: metadata(module)?.line || entry?.description || (module && summaryOf(module)) || file,
        enabled: (module ?? item).enabled,
        state: stateOf(module ?? item),
        keywords: [
            module?.summary,
            ...(module?.extensions ?? []).flatMap((extension) => extension.tools),
            ...(entry?.tags ?? []),
        ].join(" "),
    }));

    return rows.sort(
        (a, b) =>
            groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) ||
            (order.get(a.file) ?? catalog.size) - (order.get(b.file) ?? catalog.size) ||
            a.title.localeCompare(b.title),
    );
}

export function matchesRow(row, query, filter) {
    const words = query.trim().toLowerCase();

    return (
        (filter === "All" || (filter === "On") === row.enabled) &&
        [row.title, row.file, row.group, row.line, row.keywords].some((text) =>
            text.toLowerCase().includes(words),
        )
    );
}
