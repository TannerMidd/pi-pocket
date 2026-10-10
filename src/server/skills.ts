/**
 * Pi's skills for a session's folder, from the places Pi's CLI looks, in its order. The first skill of a name wins:
 *
 * 1. `.pi/skills/` in the session's folder, unless Pi was told not to trust the project.
 * 2. `.agents/skills/` in the session's folder and each folder above it, nearest first, up to the root of its git
 *    repository, or to `/` outside one. Only in a project Pi trusts, below.
 * 3. The skill paths in Pi's settings.
 * 4. `skills/` in Pi's folder (`~/.pi/agent/skills/`).
 * 5. `~/.agents/skills/`, for every session.
 *
 * Pi trusts a project when its trust store (`trust.json` in Pi's folder) says so for the folder or one above it, or
 * says nothing and Pi's `defaultProjectTrust` setting is "always". Where it says nothing, the CLI asks when it starts.
 * Pi Pocket asks its owner (`readProjectTrust` says when) and saves the answer in the same store, with the three
 * answers the CLI's `/trust` saves (`saveProjectTrust`); until then the project is not trusted, as when Pi runs without
 * a terminal. Pi also asks before it loads `.pi/skills/`: Pi Pocket loads those until it is told not to trust the
 * project (a saved "no", or `defaultProjectTrust` "never"), as it always has, and then leaves them out as Pi does.
 *
 * The search for `.agents/skills/` stops at the repository's root, as Pi's loading does; Pi's question also counts
 * folders above the root, whose skills it never loads, so Pi Pocket does not ask about those.
 *
 * This follows `addAutoDiscoveredResources` and `collectAncestorAgentsSkillDirs` in `dist/core/package-manager.js`,
 * `resolveProjectTrusted` in `dist/core/project-trust.js`, and `getProjectTrustOptions` in `dist/core/trust-manager.js`
 * of @earendil-works/pi-coding-agent, which the package does not export: check them when updating Pi.
 * `test/skills.test.ts` checks the skills against Pi's own loader.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
    CONFIG_DIR_NAME,
    loadSkills,
    ProjectTrustStore,
    type Skill,
} from "@earendil-works/pi-coding-agent";

/** What, besides the session's folder, says where skills are. */
export type SkillSources = {
    /** Pi's folder (`~/.pi/agent`): its `skills/`, and `trust.json`, which projects Pi was told to trust or not. */
    agentDir: string;
    /** The home folder, whose `.agents/skills/` every session has. */
    home: string;
    /** The skill paths in Pi's settings. */
    settingsPaths: readonly string[];
    /** Pi's `defaultProjectTrust` setting: whether a project nobody decided about is trusted. */
    defaultProjectTrust: "always" | "never" | "ask";
};

/** The root of the git repository `folder` is in, or undefined outside one. */
function gitRoot(folder: string): string | undefined {
    for (let current = folder; ; current = dirname(current)) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }

        if (dirname(current) === current) {
            return undefined;
        }
    }
}

/** The project's `.agents/skills/` folders, nearest first: in `cwd` and above it, up to its repository's root. */
function projectAgentsFolders(cwd: string, home: string): string[] {
    const top = gitRoot(cwd);
    const own = resolve(home, ".agents", "skills");
    const folders: string[] = [];

    for (let current = cwd; ; current = dirname(current)) {
        const folder = join(current, ".agents", "skills");

        // The home folder's is everyone's, not the project's, even in a session in the home folder.
        if (folder !== own && existsSync(folder)) {
            folders.push(folder);
        }

        if (current === top || dirname(current) === current) {
            return folders;
        }
    }
}

/** The answers Pi's `/trust` offers: trust the folder, trust the folder above it (and so this one too), or not. */
export type TrustChoice = "trust" | "trust-parent" | "distrust";

/** A decision in Pi's trust store: the folder it was saved for, and whether Pi trusts it and the folders in it. */
type Saved = { path: string; trusted: boolean };

/** Whether Pi trusts a session's project, and the project skills that load only while it does. */
export type ProjectTrust = {
    /** The session's folder, as the trust store names it: links resolved. */
    folder: string;
    /** The folder above it, which "trust-parent" trusts; absent at the top. */
    parent?: string;
    /** The decision saved for the folder or the nearest folder above it; null when there is none. */
    saved: Saved | null;
    /** Pi's `defaultProjectTrust` setting: it decides for a folder without a saved decision. */
    defaultProjectTrust: SkillSources["defaultProjectTrust"];
    /** Whether Pi trusts the project now. */
    trusted: boolean;
    /** The project's `.agents/skills/` folders. */
    folders: string[];
    /** The skills in them. */
    skills: { name: string; description: string }[];
    /** The skills in its `.pi/skills/`, which load unless Pi was told not to trust it. */
    ownSkills: { name: string; description: string }[];
    /** Whether to ask the owner: the project has such skills, no decision applies, and Pi's setting is to ask. */
    ask: boolean;
    /** Pi's trust store cannot be read: nothing is trusted, and no answer can be saved until it is mended. */
    unreadable?: true;
};

/** A folder as the trust store names it: links resolved, when it exists. */
function canonical(folder: string): string {
    try {
        return realpathSync(folder);
    } catch {
        return resolve(folder);
    }
}

/** The decision saved for `cwd` or the nearest folder above it: null for none, undefined for an unreadable store. */
function savedDecision(cwd: string, agentDir: string): Saved | null | undefined {
    try {
        const entry = new ProjectTrustStore(agentDir).getEntry(cwd);

        return entry === null ? null : { path: entry.path, trusted: entry.decision };
    } catch {
        return undefined;
    }
}

/**
 * What Pi decided about a project, as it decides without asking: trusted, not trusted (a saved "no", or
 * `defaultProjectTrust` "never"), or nothing yet, which includes a trust store that cannot be read.
 */
type Decision = "trusted" | "distrusted" | "undecided";

function decides(saved: Saved | null | undefined, sources: SkillSources): Decision {
    if (saved === undefined) {
        return "undecided";
    }

    if (saved !== null) {
        return saved.trusted ? "trusted" : "distrusted";
    }

    return sources.defaultProjectTrust === "always"
        ? "trusted"
        : sources.defaultProjectTrust === "never"
          ? "distrusted"
          : "undecided";
}

/**
 * Whether Pi was told not to trust the project a session in `cwd` works in (a saved "no", or `defaultProjectTrust`
 * "never"), for what of its own `.pi` folder trust gates: its `.pi/prompts` stay out then, as its `.pi/skills` do. The
 * trust store is read only for a project with `.pi/prompts`.
 */
export function projectDistrusted(cwd: string, sources: SkillSources): boolean {
    const folder = resolve(cwd);

    return (
        existsSync(join(folder, CONFIG_DIR_NAME, "prompts")) &&
        decides(savedDecision(folder, sources.agentDir), sources) === "distrusted"
    );
}

/** Where a session in `cwd` loads skills from, in order: folders, and the paths in Pi's settings as written. */
export function skillPlaces(cwd: string, sources: SkillSources): string[] {
    const folder = resolve(cwd);
    const own = join(folder, CONFIG_DIR_NAME, "skills");
    const hasOwn = existsSync(own);
    const agents = projectAgentsFolders(folder, sources.home);
    // The trust store is read only for a project with skills of its own: Pi needs no trust from one without.
    const decision =
        hasOwn || agents.length > 0
            ? decides(savedDecision(folder, sources.agentDir), sources)
            : "undecided";
    const user = [join(sources.agentDir, "skills"), join(sources.home, ".agents", "skills")];

    return [
        ...(hasOwn && decision !== "distrusted" ? [own] : []),
        ...(decision === "trusted" ? agents : []),
        ...sources.settingsPaths,
        ...user.filter((each) => existsSync(each)),
    ];
}

/** Pi's skills for a session in `cwd`: the first of each name, from `skillPlaces`. */
export function loadSessionSkills(cwd: string, sources: SkillSources): Skill[] {
    return loadSkills({
        cwd,
        agentDir: sources.agentDir,
        skillPaths: skillPlaces(cwd, sources),
        includeDefaults: false,
    }).skills;
}

/** Whether Pi trusts the project a session in `cwd` works in, and the project skills that wait for it. */
export function readProjectTrust(cwd: string, sources: SkillSources): ProjectTrust {
    const folder = canonical(cwd);
    const parent = dirname(folder);
    const saved = savedDecision(cwd, sources.agentDir);
    const folders = projectAgentsFolders(resolve(cwd), sources.home);
    const own = join(resolve(cwd), CONFIG_DIR_NAME, "skills");
    const skillsIn = (paths: string[]) =>
        paths.length === 0
            ? []
            : loadSkills({
                  cwd,
                  agentDir: sources.agentDir,
                  skillPaths: paths,
                  includeDefaults: false,
              }).skills.map(({ name, description }) => ({ name, description }));
    const skills = skillsIn(folders);
    const ownSkills = skillsIn(existsSync(own) ? [own] : []);

    return {
        folder,
        ...(parent === folder ? {} : { parent }),
        saved: saved ?? null,
        defaultProjectTrust: sources.defaultProjectTrust,
        trusted: decides(saved, sources) === "trusted",
        folders,
        skills,
        ownSkills,
        // Only about skills that would load (an empty .agents/skills, or one of files that are not skills, has none),
        // and never about a store that cannot be read: the answer could not be saved.
        ask: skills.length > 0 && saved === null && sources.defaultProjectTrust === "ask",
        ...(saved === undefined ? { unreadable: true as const } : {}),
    };
}

/** Save an answer to "trust this project?" for a session in `cwd` in Pi's trust store, as Pi's `/trust` saves it. */
export function saveProjectTrust(cwd: string, agentDir: string, choice: TrustChoice): void {
    const folder = canonical(cwd);
    const parent = dirname(folder);
    const store = new ProjectTrustStore(agentDir);

    if (choice !== "trust-parent") {
        store.set(folder, choice === "trust");

        return;
    }

    if (parent === folder) {
        throw new Error(`${folder} has no folder above it.`);
    }

    // The folder's own decision goes, so the one for the folder above applies to it.
    store.setMany([
        { path: parent, decision: true },
        { path: folder, decision: null },
    ]);
}
