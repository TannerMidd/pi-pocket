import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { HeldDoc, SessionsDoc } from "../src/server/docs.ts";
import { conversationRoutes } from "../src/server/http/conversation-routes.ts";
import type { ApiRequest } from "../src/server/http/io.ts";
import { userContent } from "../src/server/resend.ts";
import { uploadRefs, issueUpload } from "../src/server/upload-references.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("Received.")])));
});

after(async () => {
    try {
        await app?.close();
    } finally {
        cleanUp();
    }
});

function upload(id: ConversationId, name: string) {
    const path = join(app.workspace.uploadDirectory(id), name);

    writeFileSync(path, name);

    return { path, name, mime: "text/plain", size: Buffer.byteLength(name) };
}

function reader(id: ConversationId) {
    return app.config.addUser(`Reader ${id}`, "guest", [String(id)]).user;
}

async function entryIds(id: ConversationId, kind: string) {
    const page = await (await app.conversation(id)).entries({}, 64, undefined, context);

    return page.items
        .filter(
            (entry) =>
                entry.kind === kind || (kind === "pi.user" && entry.kind === "pocket.upload-input"),
        )
        .map((entry) => Number(entry.id));
}

async function forkAtAnswer(id: ConversationId) {
    const [answer] = await entryIds(id, "pi.assistant");

    assert.ok(answer !== undefined);

    return (await app.commands.fork(id, owner(app), { entryId: answer })).id;
}

async function resendFirst(id: ConversationId) {
    const messages = await entryIds(id, "pi.user");

    assert.ok(messages.length > 0);
    const { id: retry } = await app.commands.resend(id, owner(app), {
        entryId: Math.min(...messages),
        text: "Revised first message",
    });

    await until(
        async () => (await entryIds(retry, "pi.assistant")).length === 1,
        "the resend answer",
    );

    return retry;
}

async function allows(id: ConversationId, user: User, file: { path: string; name: string }) {
    const handle = app.workspace.conversationFile(user, id, file.path);

    assert.equal(typeof handle === "string" ? handle : handle.path, file.path);
    const view = await app.workspace.viewFile(id, user, file.path);

    assert.equal(view.kind, "text");
    assert.equal(view.text, file.name);
}

async function denies(id: ConversationId, user: User, ...paths: string[]) {
    for (const path of paths) {
        await assert.rejects(async () => app.workspace.conversationFile(user, id, path), {
            status: 404,
        });
        await assert.rejects(app.workspace.viewFile(id, user, path), { status: 404 });
    }
}

test("forks and resends share individual attachments, not the source upload folder", async () => {
    const source = await newSession(app);
    const first = upload(source, "first.txt");
    const workspaceFile = { path: join(work, "project.txt"), name: "Shared project notes" };

    writeFileSync(workspaceFile.path, workspaceFile.name);
    await issueUpload(app, source, first);
    await say(app, source, "First message", [first]);
    const unattached = upload(source, "draft.txt");

    await app.harness.commit(async (tx) => {
        for (let index = 0; index < 34; index++) {
            await tx.appendEntry(source, { kind: "fixture.note" });
        }
    }, context);
    await say(app, source, "Fork after these notes");
    const fork = await forkAtAnswer(source);
    const later = upload(source, "later.txt");

    await issueUpload(app, source, later);
    await say(app, source, "Later message", [later]);
    const branchFile = upload(fork, "branch.txt");

    await issueUpload(app, fork, branchFile);
    await say(app, fork, "Branch message", [branchFile]);
    const nested = await forkAtAnswer(fork);
    const earlier = (
        await app.commands.fork(fork, owner(app), {
            entryId: Math.min(...(await entryIds(fork, "pi.assistant"))),
        })
    ).id;

    await allows(earlier, reader(earlier), first);
    await denies(earlier, reader(earlier), branchFile.path);
    const retry = await resendFirst(source);
    const sourceReader = reader(source);

    await denies(fork, sourceReader, first.path);

    await allows(source, sourceReader, first);
    await allows(source, sourceReader, later);
    await denies(source, sourceReader, app.workspace.uploadDirectory(fork), branchFile.path);

    for (const id of [fork, nested, retry]) {
        const user = reader(id);

        await allows(id, user, first);
        await allows(id, user, workspaceFile);
        await denies(id, user, app.workspace.uploadDirectory(source), later.path, unattached.path);

        if (id !== retry) {
            await allows(id, user, branchFile);
        }

        if (id !== fork) {
            await denies(id, user, app.workspace.uploadDirectory(fork));
        }
    }

    // Remove an intermediate fork and its source from this fixture. The surviving fork keeps both files.
    const who = owner(app);

    for (const id of [fork, source]) {
        await app.commands.updateSession(id, who, { archived: true });
    }

    const removed = await app.sessionCleanup.remove(who.id, [fork, source]);

    assert.ok(removed.every((item) => item.done));
    await allows(nested, reader(nested), first);
    await allows(nested, reader(nested), branchFile);
    await denies(nested, reader(nested), later.path);
});

test("fork reads and transfers stay bound to the submitted bytes", async () => {
    const source = await newSession(app, app.dataDir);
    const name = "one-pixel.gif";
    const file = upload(source, name);
    const original = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
    const revision = Buffer.from(original);

    revision[revision.length - 1] = 0;
    writeFileSync(file.path, original);
    const descriptor = { ...file, mime: "image/gif", size: original.length };

    await issueUpload(app, source, descriptor);
    await say(app, source, "Original", [descriptor]);
    const fork = await forkAtAnswer(source);
    const user = reader(fork);
    const ref = String(source) + "/" + name;
    const meta = app.sessionMeta(fork)!;

    assert.ok(meta.inheritedUploadContent?.[ref]);

    for (const route of ["file", "download"]) {
        const chunks: Buffer[] = [];
        const response = Object.assign(
            new Writable({
                write(chunk, _enc, next) {
                    chunks.push(Buffer.from(chunk));
                    next();
                },
            }),
            {
                writeHead(status: number) {
                    assert.equal(status, 200);
                    // Once a response has headers, later edits cannot change its verified body.
                    writeFileSync(file.path, revision);
                },
            },
        );
        const api = {
            app,
            user,
            request: { method: "GET", headers: {} },
            response,
            url: { searchParams: new URLSearchParams({ path: file.path }) },
        } as unknown as ApiRequest;

        writeFileSync(file.path, original);
        await conversationRoutes(api, fork, ["c", String(fork), route]);
        assert.deepEqual(Buffer.concat(chunks), original);
        await assert.rejects(conversationRoutes(api, fork, ["c", String(fork), route]), {
            status: 404,
        });
    }

    const listingPath = "uploads/" + ref;

    assert.ok(!(await app.workspace.fileList(fork, user)).files.includes(listingPath));
    await assert.rejects(app.workspace.viewFile(fork, user, file.path), { status: 404 });
    assert.equal(await app.workspace.uploadGrant(fork)(ref), undefined);
    const nested = await forkAtAnswer(fork);
    const fromChangedSource = await forkAtAnswer(source);

    assert.deepEqual(app.sessionMeta(nested)?.inheritedUploads, []);
    assert.deepEqual(app.sessionMeta(fromChangedSource)?.inheritedUploads, []);

    const text = "Recovered text without changed attachment";
    const task = await app.harness.commit(
        (tx) =>
            tx.createTask(
                app.commands.resendTask,
                {
                    text,
                    by: owner(app).id,
                    uploadsApproved: true,
                    uploads: [ref],
                    contentByRef: meta.inheritedUploadContent,
                },
                { ownership: { kind: "conversation" }, background: true, conversationId: fork },
            ),
        context,
    );

    await app.harness.waitForTask(task, context);
    const rows = (await (await app.conversation(fork)).entries({}, 32, undefined, context)).items;
    const recovered = rows.find((row) => userContent(row.model?.[0]).text === text);

    assert.ok(recovered);
    assert.deepEqual(uploadRefs(recovered), []);

    writeFileSync(file.path, original);
    assert.ok((await app.workspace.fileList(fork, user)).files.includes(listingPath));
    await app.harness.commit(async (tx) => {
        delete (await tx.doc(SessionsDoc)).items[String(fork)]!.inheritedUploadContent;
    }, context);
    await denies(fork, user, file.path);
    assert.deepEqual(app.sessionMeta(await forkAtAnswer(fork))?.inheritedUploads, []);
});

test("preview and download stop at their workspace authorization check", async () => {
    const id = 21 as unknown as ConversationId;
    const user = { role: "guest", sessions: [String(id)] };
    const refused = new Error("workspace refused the file");

    for (const [route, check] of [
        ["file", "conversationFile"],
        ["download", "readableFile"],
    ] as const) {
        const api = {
            user,
            url: { searchParams: new URLSearchParams({ path: "sample.png" }) },
            request: { method: "GET" },
            app: {
                requireSteer() {},
                workspace: {
                    [check](person: unknown, session: unknown, path: unknown) {
                        assert.equal(person, user);
                        assert.equal(session, id);
                        assert.equal(path, "sample.png");

                        throw refused;
                    },
                },
            },
        } as unknown as ApiRequest;

        await assert.rejects(
            conversationRoutes(api, id, ["c", String(id), route]),
            (error) => error === refused,
        );
    }
});

test("an incomplete fork record does not grant ancestor files", async () => {
    const source = await newSession(app);
    const file = upload(source, "original.txt");

    await issueUpload(app, source, file);
    await say(app, source, "Attached", [file]);
    const fork = await forkAtAnswer(source);
    const user = reader(fork);

    await allows(fork, user, file);
    await app.harness.commit(async (tx) => {
        delete (await tx.doc(SessionsDoc)).items[String(fork)]!.forkedFrom;
    }, context);
    await denies(fork, user, file.path);

    const who = owner(app);

    await app.commands.updateSession(source, who, { archived: true });
    const [removed] = await app.sessionCleanup.remove(who.id, [source]);

    assert.ok(removed?.done);
    assert.ok(
        existsSync(file.path),
        "cleanup retains referenced bytes despite the incomplete lineage",
    );
});

test("an older attachment-only draft stays held when its attachments cannot be verified", async () => {
    const id = await newSession(app);
    const by = owner(app);
    const message = {
        by: by.id,
        key: "old-draft",
        requestId: "old-draft",
        mode: "followUp" as const,
        heldAt: 1,
        content: "Attached files (saved on the server):\n- sample",
    };

    await app.harness.commit(async (tx) => {
        (await tx.doc(HeldDoc, id)).items.push(message);
    }, context);
    await assert.rejects(app.commands.editHeld(id, by, message.key), /message has not changed/);
    assert.deepEqual((await app.harness.snapshot(HeldDoc, id, context))?.items, [message]);
});

test("legacy attachment text does not grant a fork or resend access to an upload", async () => {
    const source = await newSession(app);
    const file = upload(source, "legacy.txt");
    const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const submission = await (
        await app.conversation(source)
    ).submit(
        {
            type: "input",
            content: [
                {
                    type: "text",
                    text: `Attached files (saved on the server):\n- ${file.path} (${file.name}, text/plain, ${file.size} bytes)`,
                },
                { type: "image", mimeType: "image/png", data: png },
            ],
        },
        context,
    );

    await submission.wait(context);
    const fork = await forkAtAnswer(source);
    const retry = await resendFirst(source);
    const [original] = await entryIds(source, "pi.user");
    const preview = await app.transcripts.entryImage(fork, original!, 0);

    assert.equal(preview?.data.toString("base64"), png, "the fork retains its embedded preview");

    for (const id of [fork, retry]) {
        assert.deepEqual(
            app.sessionMeta(id)?.inheritedUploads,
            [],
            "a new fork records a known empty grant set",
        );
        await denies(id, reader(id), file.path, app.workspace.uploadDirectory(source));
    }
});
