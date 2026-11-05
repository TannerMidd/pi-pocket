// Only built-in display metadata is translated. Drop-in names, identifiers and model instructions stay literal.
import { t } from "./ui-locale.js";

/** Only the built-in ask form has this fixed title; its generated questions and answers stay literal. */
export function askTitle(approval) {
    return approval.tool === "ask" && approval.form?.title === "Pi asks"
        ? t("web.ask.title", "Pi asks")
        : (approval.form?.title ?? approval.subject);
}

export function moduleTitle(module) {
    if (module.source !== "built-in") {
        return module.title;
    }

    switch (module.file) {
        case "prompt.ts":
            return t("builtin.module.prompt.title", "System prompt");
        case "artifacts.ts":
            return t("builtin.module.artifacts.title", "Artifacts");
        case "browser.ts":
            return t("builtin.module.browser.title", "Browser");
        case "diagrams.ts":
            return t("builtin.module.diagrams.title", "Diagrams");
        case "subagents.ts":
            return t("builtin.module.subagents.title", "Subagents");
        case "agent-teams.ts":
            return t("builtin.module.agent-teams.title", "Agent Teams");
        case "schedules.ts":
            return t("builtin.module.schedules.title", "Scheduled messages");
        case "background.ts":
            return t("builtin.module.background.title", "Background tasks");
        case "goals.ts":
            return t("builtin.module.goals.title", "Done when");
        case "plan.ts":
            return t("builtin.module.plan.title", "Plan mode");
        case "anthropic-subscription.ts":
            return t("builtin.module.anthropic-subscription.title", "Claude subscription billing");
        case "memory.ts":
            return t("builtin.module.memory.title", "Memory");
        case "triggers.ts":
            return t("builtin.module.triggers.title", "Triggers");
        case "gallery.ts":
            return t("builtin.module.gallery.title", "Extension gallery");
        case "session-tags.ts":
            return t("builtin.module.session-tags.title", "Session tags");
        case "ask.ts":
            return t("builtin.module.ask.title", "Ask");
        case "ask-someone.ts":
            return t("builtin.module.ask-someone.title", "Ask someone");
        case "updates.ts":
            return t("builtin.module.updates.title", "Pi Pocket updates");
        case "tool-search.ts":
            return t("builtin.module.tool-search.title", "Tool search");
        case "design.ts":
            return t("builtin.module.design.title", "Design");
        case "guard.ts":
            return t("builtin.module.guard.title", "Lancet Guard");
        case "codemode.ts":
            return t("builtin.module.codemode.title", "Codemode");
        case "pip.ts":
            return t("builtin.module.pip.title", "PiP");
        case "zh-cn.ts":
            return t("builtin.module.zh-cn.title", "Zh cn");
        default:
            return module.title;
    }
}

export function moduleSummary(module) {
    if (module.source !== "built-in") {
        return module.summary;
    }

    switch (module.file) {
        case "prompt.ts":
            return t(
                "builtin.module.prompt.summary",
                "Who the agent is, how to behave on a phone-sized screen, where Pi Pocket's documentation is, the project's AGENTS.md files, Pi's skills, and the working directory.",
            );
        case "artifacts.ts":
            return t(
                "builtin.module.artifacts.summary",
                "HTML pages, Markdown documents, and SVG images the agent publishes for the user to open in the app, and HTML pages it shows as a card in its reply (`artifact_inline`, the same store).",
            );
        case "browser.ts":
            return t(
                "builtin.module.browser.summary",
                "Pi opens, reads, clicks through, and screenshots web pages in a real Chromium on this machine, the same page the people in the conversation watch and use in the Browser panel.",
            );
        case "diagrams.ts":
            return t(
                "builtin.module.diagrams.summary",
                "Mermaid diagrams and inline math render with local browser libraries.",
            );
        case "subagents.ts":
            return t(
                "builtin.module.subagents.summary",
                "Persistent background subagents, after Pi Durable's example 23.",
            );
        case "agent-teams.ts":
            return t(
                "builtin.module.agent-teams.summary",
                "Agent Teams lets Pi start linked sessions, each an ordinary session of its own, and send them tasks, questions, and findings.",
            );
        case "schedules.ts":
            return t(
                "builtin.module.schedules.summary",
                "Scheduled messages go to Pi later, or on repeat: people set them up with /schedule, and Pi with its schedule tool, to check back on something slow or for a regular job.",
            );
        case "background.ts":
            return t(
                "builtin.module.background.summary",
                "Background tasks let Pi start a command and not wait for it (a dev server, a long build, a test run), read what it printed later, and stop it; Pi gets a message when it ends.",
            );
        case "goals.ts":
            return t(
                "builtin.module.goals.summary",
                "Pi keeps working until a session's check command passes, such as npm test, up to five checks.",
            );
        case "plan.ts":
            return t(
                "builtin.module.plan.summary",
                "Plan mode lets Pi read and explore but change nothing, so it proposes a plan for people to approve first.",
            );
        case "anthropic-subscription.ts":
            return t(
                "builtin.module.anthropic-subscription.summary",
                "Adds the header that makes Anthropic count Pi Pocket's requests against a Claude subscription.",
            );
        case "guard.ts":
            return t("builtin.module.guard.summary", "Lancet Guard for Pi Pocket's tools.");
        case "codemode.ts":
            return t(
                "builtin.module.codemode.summary",
                "Codemode lets the agent write JavaScript that calls its other tools, to batch independent calls, chain them, or filter large output before it reaches the model.",
            );
        case "memory.ts":
            return t(
                "builtin.module.memory.summary",
                "Memory gives Pi short lessons that last across sessions, for a project or for everywhere: Pi proposes them with its memory tool, the owner approves them (under the call, or in Menu → Memory), and every later session in the same project gets them in its system prompt.",
            );
        case "pip.ts":
            return t(
                "builtin.module.pip.summary",
                "PiP, the owner's assistant over every screen: it finds out what sessions are doing, starts and messages them, stops and archives them, schedules messages, follows runs until they end, watches the owner's GitHub repositories and pull requests and acts on what happens there, and can deny (never allow) calls waiting for approval.",
            );
        case "triggers.ts":
            return t(
                "builtin.module.triggers.summary",
                "Triggers start work from outside the app: a PR watch tells Pi when its pull request's checks fail, it has conflicts, or reviewers comment, until it is merged; repository watches tell PiP what happens on the owner's repositories; webhooks turn posts from other services into messages to a session or to PiP.",
            );
        case "gallery.ts":
            return t(
                "builtin.module.gallery.summary",
                "Find drop-ins and themes other people wrote in a reviewed index, install them (drop-ins off), read their code, ask Pi to review it, update them with a diff, remove them, and share your own.",
            );
        case "session-tags.ts":
            return t(
                "builtin.module.session-tags.summary",
                "Shared labels on sessions, shown on their rows, found by search, and used to filter the session list.",
            );
        case "ask.ts":
            return t(
                "builtin.module.ask.summary",
                "Pi asks you up to 4 questions on a card in the session, each with 2 to 4 answers to tap or one of your own.",
            );
        case "ask-someone.ts":
            return t(
                "builtin.module.ask-someone.summary",
                "Pi writes a question that someone outside the chat can answer, and you share it by link or as text.",
            );
        case "updates.ts":
            return t(
                "builtin.module.updates.summary",
                "Updates of Pi Pocket itself: it looks for a new release every 6 hours, tells the owner, shows its notes, and updates the git checkout or the global npm install to it with one tap, then restarts; it can also install new releases by itself while no session is working.",
            );
        case "design.ts":
            return t(
                "builtin.module.design.summary",
                "A canvas beside the chat for interactive designs.",
            );
        case "tool-search.ts":
            return t(
                "builtin.module.tool-search.summary",
                "Tool search keeps tools that few conversations use out of every request until Pi asks for them.",
            );
        case "zh-cn.ts":
            return t(
                "builtin.module.zh-cn.summary",
                "Simplified Chinese UI text, selected in Appearance and removed when this module is off.",
            );
        default:
            return module.summary;
    }
}
