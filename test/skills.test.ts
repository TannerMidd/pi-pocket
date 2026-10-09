// Pi's skills: the places a session finds them, which of a name wins, project trust, and that it matches Pi's CLI.
import {
    type App,
    cleanUp,
    home,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
    DefaultResourceLoader,
    ProjectTrustStore,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createHandler } from "../src/server/http.ts";
import {
    loadSessionSkills,
    readProjectTrust,
    saveProjectTrust,
    type SkillSources,
    skillPlaces,
    type TrustChoice,
} from "../src/server/skills.ts";

/** The system prompt of the newest request to Pi, its sections as JSON. */
let prompt = "";

const route: FauxResponseStep = (context) => {
    prompt = JSON.stringify(
        (context.messages as { role: string; sections?: Record<string, string> }[])
            .filter((message) => message.role === "system")
            .map((message) => message.sections ?? {}),
    );

    return fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);
};

let app: App | undefined;

/** The app, opened by the first test that needs it. */
const started = async () =>
    (app ??= await openApp(scriptedModel(route), join(root, "skills-data")));

after(async () => {
    await app?.close();
    cleanUp();
});

/** A skill folder `name` in `folder`, described as `description`. */
function skill(folder: string, name: string, description = `The ${name} skill.`): void {
    mkdirSync(join(folder, name), { recursive: true });
    writeFileSync(
        join(folder, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nThe steps of ${name}.\n`,
    );
}

/**
 * A home folder with Pi's folder in it, and a git repository in it whose session folder is `repo/app`. Skills in every
 * place: `.agents/skills` above the repository (never read), in it, and in the session's folder; the project's
 * `.pi/skills`; a folder named in Pi's settings; Pi's `skills/`; and the home folder's `.agents/skills`.
 */
function fixture() {
    const base = realpathSync(mkdtempSync(join(root, "skills-")));
    const own = join(base, "home");
    const agentDir = join(own, ".pi", "agent");
    const outside = join(own, "code");
    const repo = join(outside, "repo");
    const cwd = join(repo, "app");
    const extra = join(base, "extra");

    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    skill(join(outside, ".agents", "skills"), "outside");
    skill(join(repo, ".agents", "skills"), "repo-wide");
    skill(join(cwd, ".agents", "skills"), "here");
    skill(join(cwd, ".pi", "skills"), "pi-project");
    skill(extra, "from-settings");
    skill(join(agentDir, "skills"), "pi-user");
    skill(join(own, ".agents", "skills"), "everywhere");

    const sources: SkillSources = {
        agentDir,
        home: own,
        settingsPaths: [extra],
        defaultProjectTrust: "ask",
    };

    return { base, home: own, agentDir, repo, cwd, extra, sources };
}

const names = (cwd: string, sources: SkillSources) =>
    loadSessionSkills(cwd, sources)
        .map((each) => each.name)
        .sort();

test("a session in a trusted project finds skills in every place Pi looks, in Pi's order", () => {
    const { home: own, agentDir, repo, cwd, extra, sources } = fixture();

    new ProjectTrustStore(agentDir).set(cwd, true);
    assert.deepEqual(skillPlaces(cwd, sources), [
        join(cwd, ".pi", "skills"),
        join(cwd, ".agents", "skills"),
        join(repo, ".agents", "skills"),
        extra,
        join(agentDir, "skills"),
        join(own, ".agents", "skills"),
    ]);
    assert.deepEqual(names(cwd, sources), [
        "everywhere",
        "from-settings",
        "here",
        "pi-project",
        "pi-user",
        "repo-wide",
    ]);
});

test("a project's .agents/skills load only when Pi trusts the project", () => {
    const { agentDir, repo, cwd, sources } = fixture();
    const always: SkillSources = { ...sources, defaultProjectTrust: "always" };
    const never: SkillSources = { ...sources, defaultProjectTrust: "never" };
    const projectOnes = ["here", "repo-wide"];
    const has = (list: string[]) => projectOnes.every((name) => list.includes(name));
    const lacks = (list: string[]) => projectOnes.every((name) => !list.includes(name));

    // Nobody decided: Pi would ask, and Pi Pocket cannot. The rest still load.
    assert.ok(lacks(names(cwd, sources)));
    assert.deepEqual(names(cwd, sources), ["everywhere", "from-settings", "pi-project", "pi-user"]);
    assert.ok(has(names(cwd, always)), "defaultProjectTrust: always trusts an undecided project");
    assert.ok(lacks(names(cwd, never)));
    // Told no, as by defaultProjectTrust "never", its .pi/skills stay out too, as in Pi.
    assert.ok(!names(cwd, never).includes("pi-project"));

    // A decision for the repository counts for the folders in it, and wins over the default.
    new ProjectTrustStore(agentDir).set(repo, true);
    assert.ok(has(names(cwd, sources)));
    assert.ok(has(names(cwd, never)));
    new ProjectTrustStore(agentDir).set(cwd, false);
    assert.ok(lacks(names(cwd, always)), "the nearest decision wins");
    assert.ok(!names(cwd, always).includes("pi-project"), "a saved no keeps .pi/skills out too");
});

test("an unreadable trust store trusts no project", () => {
    const { agentDir, cwd, sources } = fixture();

    writeFileSync(join(agentDir, "trust.json"), "{ not json");
    assert.ok(!names(cwd, { ...sources, defaultProjectTrust: "always" }).includes("here"));
});

test("the home folder's .agents/skills are everyone's, even for a session in the home folder", () => {
    const { home: own, agentDir, sources } = fixture();
    const loose = join(own, "notes");

    mkdirSync(loose);

    // Outside a repository the search goes up to the root, past the home folder: its skills are not the project's,
    // so they need no trust, and they keep their place after Pi's own, trusted project or not.
    for (const cwd of [own, loose]) {
        for (const defaultProjectTrust of ["ask", "always"] as const) {
            assert.deepEqual(skillPlaces(cwd, { ...sources, defaultProjectTrust }), [
                sources.settingsPaths[0],
                join(agentDir, "skills"),
                join(own, ".agents", "skills"),
            ]);
        }

        assert.ok(names(cwd, sources).includes("everywhere"));
    }
});

test("the first skill of a name wins: the project's over Pi's settings over the user's", () => {
    const { home: own, agentDir, repo, cwd, extra, sources } = fixture();
    const winner = (name: string) =>
        loadSessionSkills(cwd, sources).find((each) => each.name === name)?.description;

    new ProjectTrustStore(agentDir).set(repo, true);
    skill(join(own, ".agents", "skills"), "shared", "From the home folder.");
    skill(join(agentDir, "skills"), "shared", "From Pi's folder.");
    assert.equal(winner("shared"), "From Pi's folder.");
    skill(extra, "shared", "From Pi's settings.");
    assert.equal(winner("shared"), "From Pi's settings.");
    skill(join(repo, ".agents", "skills"), "shared", "From the repository.");
    assert.equal(winner("shared"), "From the repository.");
    skill(join(cwd, ".agents", "skills"), "shared", "From the session's folder.");
    assert.equal(winner("shared"), "From the session's folder.");
    skill(join(cwd, ".pi", "skills"), "shared", "From the project's .pi.");
    assert.equal(winner("shared"), "From the project's .pi.");
});

test("a skill linked into two places is listed once", () => {
    const { home: own, agentDir, cwd, sources } = fixture();

    // As Omarchy installs its skills: links in both ~/.pi/agent/skills and ~/.agents/skills to one folder.
    skill(join(own, "shared-skills"), "linked");
    symlinkSync(join(own, "shared-skills", "linked"), join(agentDir, "skills", "linked"));
    symlinkSync(join(own, "shared-skills", "linked"), join(own, ".agents", "skills", "linked"));
    assert.equal(names(cwd, sources).filter((name) => name === "linked").length, 1);
});

/** The skills Pi's CLI loads in `cwd`: its resource loader, with `home` as the home folder. */
async function cliSkills(cwd: string, home: string, agentDir: string, trusted: boolean) {
    const before = process.env.HOME;

    process.env.HOME = home;

    try {
        const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });

        await loader.reload();

        return loader.getSkills().skills;
    } finally {
        if (before === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = before;
        }
    }
}

test("a session has the skills Pi's CLI has in the same folder, the same one of each name", async () => {
    const { home: own, agentDir, repo, cwd, extra, sources } = fixture();
    const found = (skills: { name: string; filePath: string }[]) =>
        skills
            .map(({ name, filePath }) => ({ name, filePath }))
            .sort((a, b) => a.name.localeCompare(b.name));

    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [extra] }));
    // Names in several places, so the comparison covers which one wins.
    skill(join(own, ".agents", "skills"), "pi-user", "The home folder's, shadowed by Pi's own.");
    skill(join(agentDir, "skills"), "from-settings", "Pi's folder's, shadowed by the settings'.");
    skill(join(repo, ".agents", "skills"), "here", "The repository's, shadowed by the nearer one.");
    skill(join(cwd, ".agents", "skills"), "pi-project", "Shadowed by the project's .pi/skills.");

    // Untrusted, the CLI skips the project's .pi/skills too, which Pi Pocket keeps: compare without it.
    const untrusted = loadSessionSkills(cwd, sources).filter((each) => each.name !== "pi-project");

    assert.deepEqual(found(untrusted), found(await cliSkills(cwd, own, agentDir, false)));
    new ProjectTrustStore(agentDir).set(cwd, true);
    assert.deepEqual(
        found(loadSessionSkills(cwd, sources)),
        found(await cliSkills(cwd, own, agentDir, true)),
    );
    // Told not to trust it: exactly the CLI's, .pi/skills left out as well.
    new ProjectTrustStore(agentDir).set(cwd, false);
    assert.deepEqual(
        found(loadSessionSkills(cwd, sources)),
        found(await cliSkills(cwd, own, agentDir, false)),
    );
});

test("a session lists them as /skill: commands and in its system prompt", async () => {
    const project = realpathSync(mkdtempSync(join(root, "skills-project-")));

    mkdirSync(join(project, ".git"));
    skill(join(home, ".agents", "skills"), "everywhere");
    skill(join(project, ".agents", "skills"), "here");
    new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).set(project, true);
    const app = await started();
    const id = await newSession(app, project);

    assert.deepEqual(
        app
            .skillCommands(id)
            .map((each) => each.name)
            .sort(),
        ["everywhere", "here"],
    );
    await say(app, id, "hello");
    assert.match(prompt, /<name>everywhere<\/name>/);
    assert.match(prompt, /<name>here<\/name>/);
    assert.ok(prompt.includes(join(project, ".agents", "skills", "here", "SKILL.md")));
    await say(app, id, "/skill:here do the thing");
    assert.match((await modelTexts(app, id)).join("\n"), /<skill name=\\"here\\" location=/);
});

test("an undecided project with skills of its own asks; one without, or with a default, does not", () => {
    const { base, agentDir, repo, cwd, extra, sources } = fixture();
    const asked = readProjectTrust(cwd, sources);

    assert.deepEqual(
        { ...asked, skills: asked.skills.map((each) => each.name).sort() },
        {
            folder: cwd,
            parent: repo,
            saved: null,
            defaultProjectTrust: "ask",
            trusted: false,
            folders: [join(cwd, ".agents", "skills"), join(repo, ".agents", "skills")],
            skills: ["here", "repo-wide"],
            ask: true,
        },
    );
    assert.deepEqual(
        [readProjectTrust(cwd, { ...sources, defaultProjectTrust: "always" })].map(
            ({ trusted, ask }) => ({ trusted, ask }),
        ),
        [{ trusted: true, ask: false }],
    );
    assert.deepEqual(
        [readProjectTrust(cwd, { ...sources, defaultProjectTrust: "never" })].map(
            ({ trusted, ask }) => ({ trusted, ask }),
        ),
        [{ trusted: false, ask: false }],
    );
    // Nothing of its own to load: nothing to ask about.
    assert.equal(readProjectTrust(extra, sources).ask, false);
    assert.deepEqual(readProjectTrust(extra, sources).folders, []);
    // Nor when the trust store cannot be read: the answer could not be saved.
    writeFileSync(join(agentDir, "trust.json"), "{ not json");
    assert.deepEqual(
        [readProjectTrust(cwd, sources)].map(({ saved, trusted, ask, unreadable }) => ({
            saved,
            trusted,
            ask,
            unreadable,
        })),
        [{ saved: null, trusted: false, ask: false, unreadable: true }],
    );
    assert.throws(() => saveProjectTrust(cwd, agentDir, "trust"));
    assert.equal(readProjectTrust(base, sources).parent, dirname(base));
});

/** Pi's own answers to "trust this project?", from the CLI's code (the package does not export it). */
async function piTrustOptions(cwd: string) {
    const index = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const manager = (await import(
        pathToFileURL(join(dirname(index), "core", "trust-manager.js")).href
    )) as {
        getProjectTrustOptions: (cwd: string) => {
            label: string;
            updates: { path: string; decision: boolean | null }[];
        }[];
    };

    return manager.getProjectTrustOptions(cwd);
}

test("each answer saves what Pi's /trust saves, and decides which skills load", async () => {
    const { cwd, sources } = fixture();
    const options = await piTrustOptions(cwd);
    const piLabel: Record<TrustChoice, (label: string) => boolean> = {
        trust: (label) => label === "Trust",
        "trust-parent": (label) => label.startsWith("Trust parent folder"),
        distrust: (label) => label === "Do not trust",
    };
    const has = (agentDir: string) =>
        loadSessionSkills(cwd, { ...sources, agentDir }).some((each) => each.name === "here");

    for (const choice of ["trust", "trust-parent", "distrust"] as const) {
        // Both stores start with decisions for this folder and the one above it, which an answer may replace.
        const ours = realpathSync(mkdtempSync(join(root, "trust-ours-")));
        const pis = realpathSync(mkdtempSync(join(root, "trust-pi-")));
        const before = [
            { path: cwd, decision: false },
            { path: dirname(cwd), decision: false },
        ];

        new ProjectTrustStore(ours).setMany(before);
        new ProjectTrustStore(pis).setMany(before);
        saveProjectTrust(cwd, ours, choice);
        new ProjectTrustStore(pis).setMany(
            options.find((option) => piLabel[choice](option.label))!.updates,
        );
        assert.equal(
            readFileSync(join(ours, "trust.json"), "utf8"),
            readFileSync(join(pis, "trust.json"), "utf8"),
            choice,
        );
        assert.equal(has(ours), choice !== "distrust", choice);
        assert.equal(readProjectTrust(cwd, { ...sources, agentDir: ours }).ask, false);
    }
});

test("a folder reached through a link is trusted as the folder it is", () => {
    const { base, agentDir, repo, cwd, sources } = fixture();
    const link = join(base, "link");

    symlinkSync(cwd, link);
    assert.equal(readProjectTrust(link, sources).folder, cwd);
    saveProjectTrust(link, agentDir, "trust");
    assert.deepEqual(readProjectTrust(cwd, sources).saved, { path: cwd, trusted: true });
    assert.ok(names(link, sources).includes("here"));
    // The folder above is the real one's, not the link's.
    assert.equal(readProjectTrust(link, sources).parent, repo);
    saveProjectTrust(link, agentDir, "trust-parent");
    assert.deepEqual(readProjectTrust(cwd, sources).saved, { path: repo, trusted: true });
});

test("the top folder has no folder above it to trust", () => {
    const { agentDir, sources } = fixture();

    assert.equal(readProjectTrust("/", sources).parent, undefined);
    assert.throws(() => saveProjectTrust("/", agentDir, "trust-parent"), /no folder above it/);
});

test("the owner answers through the API, a guest cannot, and Pi has the skills from its next message", async () => {
    const app = await started();
    const project = realpathSync(mkdtempSync(join(root, "skills-asking-")));

    mkdirSync(join(project, ".git"));
    skill(join(project, ".agents", "skills"), "waiting");
    const id = await newSession(app, project);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Guest", "guest");
    const call = (token: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/c/${id}/trust`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    try {
        await say(app, id, "first");
        assert.doesNotMatch(prompt, /<name>waiting<\/name>/);
        assert.ok(!app.skillCommands(id).some((each) => each.name === "waiting"));

        const asked = await call(app.config.ownerToken);

        assert.equal(asked.status, 200);
        assert.equal(((await asked.json()) as { ask: boolean }).ask, true);
        assert.equal(
            (await call(guest.token)).status,
            403,
            "the skills may be in folders a guest cannot see",
        );
        assert.equal((await call(guest.token, { choice: "trust" })).status, 403);
        assert.equal((await call(app.config.ownerToken, { choice: "maybe" })).status, 400);
        assert.equal(new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).get(project), null);

        const answered = await call(app.config.ownerToken, { choice: "trust" });

        assert.equal(answered.status, 200);
        assert.deepEqual(
            [(await answered.json()) as { trusted: boolean; ask: boolean }].map(
                ({ trusted, ask }) => ({ trusted, ask }),
            ),
            [{ trusted: true, ask: false }],
        );
        assert.equal(new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).get(project), true);
        assert.ok(app.skillCommands(id).some((each) => each.name === "waiting"));
        // At once, not when the prompt's copy of the skills grows stale.
        await say(app, id, "second");
        assert.match(prompt, /<name>waiting<\/name>/);
    } finally {
        server.closeAllConnections();
        server.close();
        app.config.removeUser(guest.user.id);
    }
});

test("the app reads Pi's settings: its default trust, and its skill paths", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const project = realpathSync(mkdtempSync(join(root, "skills-settings-")));
    const extra = realpathSync(mkdtempSync(join(root, "skills-settings-extra-")));

    mkdirSync(join(project, ".git"));
    skill(join(project, ".agents", "skills"), "by-default");
    skill(extra, "from-pi-settings");
    writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProjectTrust: "always", skills: [extra] }),
    );
    // Opened after the settings are written: an app reads Pi's settings when it opens.
    const other = await openApp(scriptedModel(route), join(root, "skills-settings-data"));

    try {
        const id = await newSession(other, project);
        const commands = other.skillCommands(id).map((each) => each.name);

        assert.ok(commands.includes("by-default"), "trusted by defaultProjectTrust");
        assert.ok(commands.includes("from-pi-settings"), "found through Pi's skill paths");
        assert.deepEqual(
            [other.projectTrust(id, owner(other))].map(({ trusted, ask }) => ({ trusted, ask })),
            [{ trusted: true, ask: false }],
        );
    } finally {
        await other.close();
        rmSync(join(agentDir, "settings.json"), { force: true });
    }
});
