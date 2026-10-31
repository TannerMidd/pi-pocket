// What the workspace asks of the server, and keeps in its store: the session's designs, a design's comments and this
// person's tweaks, "go back to this one", and a file export.
import { savePick } from "./state.js";

/** The latest version number of a listed design. */
export const latestOf = (artifact) => artifact?.versions?.at(-1)?.version ?? 1;

const timeOf = (artifact) => artifact.versions.at(-1)?.createdAt ?? 0;

/**
 * The designs of the session, newest first: the app's own list (live: it changes when Pi publishes) with what only the
 * server's list has (group, kind, restores).
 */
export function designsOf(appView, listed) {
    const extras = new Map((listed ?? []).map((each) => [each.id, each]));
    const live = (appView?.artifacts ?? []).filter((each) => each.type === "html");

    return live
        .map((each) => {
            const more = extras.get(each.id);

            return {
                id: each.id,
                title: each.title,
                group: more?.group,
                kind: more?.kind ?? "page",
                versions: each.versions.map((version) => ({
                    ...version,
                    restoredFrom: more?.versions.find((other) => other.version === version.version)
                        ?.restoredFrom,
                })),
            };
        })
        .sort((a, b) => timeOf(b) - timeOf(a));
}

/**
 * Moves the accepted findings (`accepted`: id to who and when) out of `findings`, and counts only the open ones. An already
 * split report is split again, so an accept and its undo need no new check.
 */
export function splitReport(report, accepted) {
    if (!report || !Array.isArray(report.findings)) {
        return report;
    }

    const all = [...report.findings, ...(report.accepted ?? [])];
    const at = new Map((report.order ?? []).map((id, index) => [id, index]));
    const place = (finding) => at.get(finding.id) ?? Number.MAX_SAFE_INTEGER;
    const sorted = at.size > 0 ? all.toSorted((a, b) => place(a) - place(b)) : all;
    const isAccepted = (finding) =>
        finding.id !== undefined && Object.hasOwn(accepted ?? {}, finding.id);
    const findings = sorted.filter((finding) => !isAccepted(finding));
    const byRule = {};

    for (const finding of findings) {
        byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    }

    return {
        ...report,
        findings,
        accepted: sorted.filter(isAccepted),
        summary: {
            ...report.summary,
            errors: findings.filter((finding) => finding.level === "error").length,
            warnings: findings.filter((finding) => finding.level === "warning").length,
            byRule,
        },
    };
}

const resplit = (checks, artifact, accepted) =>
    Object.fromEntries(
        Object.entries(checks).map(([key, entry]) => [
            key,
            key.startsWith(`${artifact}@`) && entry.report
                ? { ...entry, report: splitReport(entry.report, accepted) }
                : entry,
        ]),
    );

/** The designs in the same group as `artifact` (itself included), in the list's order; none when it has no group. */
export function siblingsOf(designs, artifact) {
    if (!artifact?.group) {
        return [];
    }

    return designs.filter((each) => each.group === artifact.group);
}

export function downloadFile(conversation, made) {
    const link = document.createElement("a");

    link.href = `/api/c/${encodeURIComponent(conversation)}/download?${new URLSearchParams({ path: made.relative })}`;
    link.download = made.name;
    document.body.append(link);
    link.click();
    link.remove();
}

export function createData(pocket, store) {
    const conversationOf = () => store.get().conversation;
    let listing = 0;
    /** The newest read of each design's notes: an older answer that comes later is dropped. */
    const reading = {};

    /** Whether the answer to a call made in `conversation` still matters: the tab may have moved on. */
    const current = (conversation) => store.get().conversation === conversation;

    const fail = (error) => pocket.notify("error", `Design: ${error?.message ?? error}`);

    const data = {
        /** Read the server's list of designs (their groups and kinds). */
        async list() {
            const conversation = conversationOf();

            if (conversation === null) {
                return;
            }

            const mine = ++listing;

            try {
                const { artifacts } = await pocket.api(`c/${conversation}/artifacts`);

                if (current(conversation) && mine === listing) {
                    store.set({ listed: artifacts });
                }
            } catch (error) {
                if (current(conversation) && mine === listing) {
                    store.set({ listed: store.get().listed ?? [] });
                    console.warn("Design: could not read the list", error);
                }
            }
        },

        /** Read one design's comments and this person's tweaks. */
        async notes(artifact) {
            const conversation = conversationOf();

            if (conversation === null || !artifact) {
                return;
            }

            try {
                const result = await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}`,
                );

                if (current(conversation)) {
                    store.set((state) => ({
                        notes: { ...state.notes, [artifact]: { ...result, loaded: true } },
                        checks: resplit(state.checks, artifact, result.accepted),
                    }));
                }
            } catch (error) {
                if (current(conversation) && error?.status !== 404) {
                    console.warn("Design: could not read the comments", error);
                }
            }
        },

        async accept(artifact, finding) {
            const conversation = conversationOf();

            try {
                await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}/accepted`,
                    { id: finding.id, rule: finding.rule, message: finding.message },
                );
                await data.notes(artifact);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },

        async unaccept(artifact, id) {
            const conversation = conversationOf();

            try {
                await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}/accepted/${encodeURIComponent(id)}`,
                    undefined,
                    { method: "DELETE" },
                );
                await data.notes(artifact);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },

        async addComment(artifact, version, target, text) {
            const conversation = conversationOf();

            try {
                await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}/comments`,
                    {
                        version,
                        target,
                        text,
                    },
                );
                await data.notes(artifact);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },

        async patchComment(artifact, comment, fields) {
            const conversation = conversationOf();

            try {
                await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}/comments/${comment}`,
                    fields,
                );
                await data.notes(artifact);
            } catch (error) {
                fail(error);
            }
        },

        async removeComment(artifact, comment) {
            const conversation = conversationOf();

            try {
                await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}/comments/${comment}`,
                    undefined,
                    { method: "DELETE" },
                );
                await data.notes(artifact);
            } catch (error) {
                fail(error);
            }
        },

        async resolveMany(artifact, ids) {
            const conversation = conversationOf();

            try {
                await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}/resolve`,
                    {
                        ids,
                    },
                );
                await data.notes(artifact);
            } catch (error) {
                fail(error);
            }
        },

        /** Save this person's tweaks for a design, a moment after the last change. */
        saveTweaks(artifact, values) {
            const conversation = conversationOf();

            clearTimeout(data.saving?.[artifact]);
            data.saving ??= {};
            data.saving[artifact] = setTimeout(() => {
                pocket
                    .api(`c/${conversation}/designs/${encodeURIComponent(artifact)}/tweaks`, {
                        values: values === null || Object.keys(values).length === 0 ? null : values,
                    })
                    .catch((error) => {
                        if (error?.status !== 403) {
                            console.warn("Design: could not save the tweaks", error);
                        }
                    });
            }, 600);
        },

        /** "Go back to this one": a new version with the content of `version`. Returns the new version number. */
        async restore(artifact, version) {
            const conversation = conversationOf();
            const key = crypto.randomUUID();

            try {
                const result = await pocket.api(
                    `c/${conversation}/designs/${encodeURIComponent(artifact)}/restore`,
                    { version, key },
                );

                await data.list();

                return result.version;
            } catch (error) {
                fail(error);

                return null;
            }
        },

        /**
         * Make a file on the server (PNG, PDF, PPTX, or an HTML zip: `design/index.ts`'s export route writes it in the session's
         * `exports/` folder), then save it through core's download route.
         */
        async download({ artifact, version, format, viewport }) {
            const conversation = conversationOf();

            try {
                const made = await pocket.api(`c/${conversation}/export`, {
                    id: artifact,
                    version,
                    format,
                    ...(viewport ? { viewport } : {}),
                });

                downloadFile(conversation, made);
                pocket.notify("info", `Saved ${made.name}. It is also at ${made.path}`);

                return true;
            } catch (error) {
                fail(error);

                return false;
            }
        },
    };

    // Keep the panel's choice of design for a reload of this tab.
    let picked = "";

    store.subscribe((state) => {
        if (state.conversation !== null && state.artifact !== null) {
            const pick = { artifact: state.artifact, version: state.version };
            const text = `${state.conversation}:${JSON.stringify(pick)}`;

            if (text !== picked) {
                picked = text;
                savePick(state.conversation, pick);
            }
        }
    });

    return data;
}
