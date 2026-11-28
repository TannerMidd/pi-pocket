import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { HeldDoc, IssuedUploadsDoc, SessionsDoc } from "../src/server/docs.ts";
import { conversationRoutes } from "../src/server/http/conversation-routes.ts";
import type { ApiRequest } from "../src/server/http/io.ts";
import { ManagedStorage } from "../src/server/managed-storage.ts";
import { userContent } from "../src/server/resend.ts";
import {
    type Attachment,
    createUpload,
    issueUpload,
    uploadDirectory,
    uploadInput,
    uploadRefs,
} from "../src/server/upload-references.ts";

let app: App;

before(async () => {
    app = await openApp(
        scriptedModel((request) =>
            fauxAssistantMessage([
                fauxText(
                    lastText(request as never).text.includes("keep busy")
                        ? "word ".repeat(8000)
                        : "Received.",
                ),
            ]),
        ),
    );
});

after(async () => {
    try {
        await app?.close();
    } finally {
        cleanUp();
    }
});

function upload(
    id: ConversationId,
    name: string,
    bytes = Buffer.from("sample"),
    mime = "text/plain",
) {
    const path = join(app.workspace.uploadDirectory(id), name);

    writeFileSync(path, bytes);

    return { path, name, mime, size: bytes.length };
}

test("the upload directory verifies the pinned store and each parent", () => {
    const dataDir = mkdtempSync(join(root, "writer-"));
    const store = {
        dataDir,
        canonicalDataDir: realpathSync.native(dataDir),
        managedStorage: new ManagedStorage(dataDir),
    };
    const other = mkdirSync(join(dataDir, "other"), { recursive: true })!;
    const id = 1 as unknown as ConversationId;

    assert.equal(uploadDirectory(store, id), join(dataDir, "uploads", "1"));
    assert.throws(() => uploadDirectory({ ...store, canonicalDataDir: other }, id), {
        status: 400,
    });
    symlinkSync(other, join(dataDir, "uploads", "2"), "junction");
    assert.throws(() => uploadDirectory(store, 2 as unknown as ConversationId), { status: 400 });
    assert.deepEqual(readdirSync(other), []);
});

test("the upload route returns a descriptor that survives reopening the session", async () => {
    const data = mkdtempSync(join(root, "receipts-"));
    const name = "team notes (v2)-draft.txt";
    let disk = await openApp(scriptedModel(), data);

    try {
        const id = await newSession(disk);
        const guest = disk.config.addUser("Participant", "guest", [String(id)]).user;
        let descriptor: Attachment | undefined;
        const api = {
            app: disk,
            user: guest,
            url: new URL("http://example.invalid/?" + new URLSearchParams({ name })),
            request: Object.assign(Readable.from([Buffer.from("no"), Buffer.from("tes")]), {
                method: "POST",
                headers: { "content-type": "text/plain" },
                complete: true,
            }),
            response: {
                writeHead(status: number) {
                    assert.equal(status, 200);
                },
                end(text: string) {
                    descriptor = JSON.parse(text) as Attachment;
                },
            },
        } as unknown as ApiRequest;

        await conversationRoutes(api, id, ["c", String(id), "upload"]);
        assert.equal(descriptor?.name, name);
        assert.equal(descriptor.size, 5);
        assert.equal(readFileSync(descriptor.path, "utf8"), "notes");
        await disk.close();
        disk = await openApp(scriptedModel(), data);
        assert.ok(
            (
                await disk.commands.submit(id, disk.config.userById(guest.id)!, {
                    text: "notes",
                    attachments: [descriptor],
                    requestId: "restored-upload",
                })
            ).submissionId,
        );
    } finally {
        await disk.close();
    }
});

test("a pending upload stays private and never replaces an existing file", async () => {
    const id = await newSession(app);
    const name = "agenda.txt";
    const pending = await createUpload(app, id, name);
    const bytes = Buffer.from("agenda");
    const final = join(app.workspace.uploadDirectory(id), name);

    try {
        await pending.handle.writeFile(bytes);
        assert.deepEqual(readdirSync(app.workspace.uploadDirectory(id)), []);
        writeFileSync(final, "original");
        await assert.rejects(
            pending.accept(
                owner(app).id,
                { name, mime: "text/plain", size: bytes.length },
                createHash("sha256").update(bytes).digest("hex"),
            ),
            { status: 409 },
        );
    } finally {
        await pending.close();
    }

    assert.equal(readFileSync(final, "utf8"), "original");
    assert.deepEqual((await app.harness.snapshot(IssuedUploadsDoc, id, context))?.files ?? {}, {});
    assert.deepEqual(
        readdirSync(app.dataDir).filter((file) => file.startsWith(".upload-")),
        [],
    );
});

test("the upload route checks the current requester and target before issuing a receipt", async (t) => {
    for (const change of [
        "before receipt",
        "after receipt",
        "scope",
        "removed person",
        "removed session",
        "remote workspace",
    ]) {
        const id = await newSession(app);
        const guest = app.config.addUser("Uploader", "guest", [String(id)]).user;
        const dir = app.workspace.uploadDirectory(id);

        const body = async function* () {
            yield Buffer.from("agenda");
            assert.deepEqual(readdirSync(dir), []);
            const stages = readdirSync(app.dataDir).filter((file) => file.startsWith(".upload-"));

            assert.equal(stages.length, 1);
            assert.throws(
                () => app.workspace.conversationFile(guest, id, join(app.dataDir, stages[0]!)),
                { status: 404 },
            );

            if (change === "before receipt" || change === "after receipt") {
                const commit = app.harness.commit.bind(app.harness);

                t.mock.method(
                    app.harness,
                    "commit",
                    async (...args: Parameters<typeof commit>) => {
                        const revoke = () => app.config.updateUser(guest.id, { role: "viewer" });

                        if (change === "before receipt") {
                            revoke();
                        }

                        const result = await commit(...args);

                        assert.equal(
                            change,
                            "after receipt",
                            "The receipt transaction must reject a revoked requester.",
                        );
                        assert.equal(
                            Object.keys(
                                (await app.harness.snapshot(IssuedUploadsDoc, id, context))!.files,
                            ).length,
                            1,
                        );
                        assert.deepEqual(readdirSync(dir), []);
                        revoke();

                        return result;
                    },
                    { times: 1 },
                );
            } else if (change === "scope") {
                app.config.updateUser(guest.id, { sessions: [] });
            } else if (change === "removed person") {
                app.config.removeUser(guest.id);
            } else if (change === "removed session") {
                await app.harness.commit(async (tx) => {
                    delete (await tx.doc(SessionsDoc)).items[String(id)];
                }, context);
            } else {
                await (await app.conversation(id)).configure({ cwd: "sample://test" }, context);
            }
        };

        const api = {
            app,
            user: { ...guest },
            url: new URL("http://example.invalid/?name=agenda.txt"),
            request: Object.assign(Readable.from(body()), {
                method: "POST",
                headers: { "content-type": "text/plain" },
                complete: true,
            }),
        } as unknown as ApiRequest;

        await assert.rejects(conversationRoutes(api, id, ["c", String(id), "upload"]), {
            status: change === "remote workspace" ? 400 : 403,
        });
        assert.deepEqual(readdirSync(dir), []);
        assert.deepEqual(
            (await app.harness.snapshot(IssuedUploadsDoc, id, context))?.files ?? {},
            {},
        );
        assert.deepEqual(
            readdirSync(app.dataDir).filter((file) => file.startsWith(".upload-")),
            [],
        );
    }
});

test("a failed receipt transaction publishes no file", async (t) => {
    const id = await newSession(app);
    const bytes = Buffer.from("agenda");
    const dir = app.workspace.uploadDirectory(id);
    const pending = await createUpload(app, id, "agenda.txt");
    const commit = app.harness.commit.bind(app.harness);

    writeFileSync(join(dir, "existing.txt"), "original");
    t.mock.method(
        app.harness,
        "commit",
        (change: Parameters<typeof commit>[0]) =>
            commit(async (tx) => {
                await change(tx);
                assert.deepEqual(readdirSync(dir), ["existing.txt"]);

                throw new Error("Receipt storage unavailable");
            }, context),
        { times: 1 },
    );

    try {
        await pending.handle.writeFile(bytes);
        await assert.rejects(
            pending.accept(
                owner(app).id,
                { name: "agenda.txt", mime: "text/plain", size: bytes.length },
                createHash("sha256").update(bytes).digest("hex"),
            ),
            /Receipt storage unavailable/,
        );
    } finally {
        await pending.close();
    }

    assert.deepEqual(readdirSync(dir), ["existing.txt"]);
    assert.equal(readFileSync(join(dir, "existing.txt"), "utf8"), "original");
    assert.deepEqual((await app.harness.snapshot(IssuedUploadsDoc, id, context))?.files ?? {}, {});
});

test("submitting a file requires its issued descriptor, including name and MIME", async () => {
    const id = await newSession(app);
    const file = upload(id, "notes.txt");
    const submit = (attachment: typeof file) =>
        app.commands.submit(id, owner(app), {
            text: "Notes",
            requestId: "notes",
            attachments: [attachment],
        });

    await assert.rejects(submit(file), { status: 400 });
    await issueUpload(app, id, file);
    await assert.rejects(submit({ ...file, name: "other.txt" }), { status: 400 });
    await assert.rejects(submit({ ...file, mime: "text/markdown" }), { status: 400 });
    assert.ok((await submit(file)).submissionId);
});

test("ordinary submit embeds the issued image and ignores caller-supplied content identity", async () => {
    const id = await newSession(app);
    const user = owner(app);
    const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
    );
    const file = upload(id, "tiny.png", bytes, "image/png");
    const untrusted = { ...file, content: { size: bytes.length, sha256: "0".repeat(64) } };

    await issueUpload(app, id, file);
    await app.commands.configure(id, user, { model: { provider: "faux", modelId: "faux-vision" } });
    await app.commands.submit(id, user, {
        text: "Image",
        requestId: "tiny-image",
        attachments: [untrusted],
    });
    const conversation = await app.conversation(id);
    const entries = (await conversation.entries({}, 32, undefined, context)).items;
    const input = entries.find((entry) => entry.kind === "pocket.upload-input");

    assert.deepEqual(userContent(input?.model?.[0]).images, [
        { type: "image", mimeType: "image/png", data: bytes.toString("base64") },
    ]);
});

test("failed edits preserve queued and held inputs with their embedded images", async () => {
    const id = await newSession(app);
    const user = owner(app);
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
    );
    const missing = upload(id, "missing.png", png, "image/png");
    const changed = upload(id, "changed.png", png, "image/png");
    const image = { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };

    await app.commands.configure(id, user, { model: { provider: "faux", modelId: "faux-vision" } });
    await app.commands.submit(id, user, { text: "keep busy", requestId: "busy" });
    await until(() => app.isBusy(id), "the run to start");

    try {
        for (const file of [missing, changed]) {
            await issueUpload(app, id, file);
            await app.commands.submit(id, user, {
                text: file.name,
                requestId: file.name,
                attachments: [file],
                mode: "followUp",
            });
        }

        const standalone = await app.commands.submit(id, user, {
            text: "embedded only",
            requestId: "embedded",
            mode: "followUp",
        });

        await app.harness.commit(async (tx) => {
            const item = (await tx.doc(InboxDoc, id)).items.find(
                (each) => each.id === standalone.submissionId,
            )!;

            assert.ok(item.mode !== "write");
            item.content = [image];
        }, context);
        unlinkSync(missing.path);
        writeFileSync(changed.path, Buffer.alloc(png.length));
        const queued = async () => (await app.harness.snapshot(InboxDoc, id, context))!.items;
        const before = await queued();

        assert.equal(before.length, 3);

        for (const item of before) {
            assert.ok(item.mode !== "write");
            assert.ok(
                Array.isArray(item.content) &&
                    item.content.some((part) => part.type === "image" && part.data === image.data),
            );
            await assert.rejects(
                app.commands.editQueued(id, user, Number(item.id)),
                /message has not changed/i,
            );
        }

        assert.deepEqual(await queued(), before);
        await app.commands.abort(id, user);
        await until(() => !app.isBusy(id), "the run to stop");
        const held = async () => (await app.harness.snapshot(HeldDoc, id, context))!.items;
        const originals = await held();

        assert.deepEqual(
            originals.map((item) => item.content),
            before.map((item) => {
                assert.ok(item.mode !== "write");

                return item.content;
            }),
        );

        for (const item of originals) {
            await assert.rejects(
                app.commands.editHeld(id, user, item.key),
                /message has not changed/i,
            );
        }

        assert.deepEqual(await held(), originals);
        writeFileSync(changed.path, png);
        const recovered = originals.find((item) =>
            JSON.stringify(item.content).includes(changed.name),
        )!;

        assert.deepEqual(await app.commands.editHeld(id, user, recovered.key), {
            text: changed.name,
            attachments: [changed],
        });
    } finally {
        if (app.isBusy(id)) {
            await app.commands.abort(id, user);
        }
    }
});

test("fork grants, resend inputs and durable resend tasks agree on source-approved files", async () => {
    const id = await newSession(app);
    const issued = upload(id, "issued.txt");
    const sibling = upload(id, "sibling.txt");
    const approved = [`${id}/${issued.name}`];
    const refs = [...approved, `${id}/${sibling.name}`];
    const conversation = await app.conversation(id);

    await issueUpload(app, id, issued);
    const original = await conversation.submit(
        { type: "input", content: "Fixture notes", ...uploadInput(refs) },
        context,
    );

    await original.wait(context);
    const entries = (await conversation.entries({}, 32, undefined, context)).items;
    const input = entries.find((entry) => entry.kind === "pocket.upload-input")!;
    const answer = entries.find((entry) => entry.kind === "pi.assistant")!;

    assert.deepEqual(uploadRefs(input), refs);
    const fork = await app.commands.fork(id, owner(app), { entryId: Number(answer.id) });
    const retry = await app.commands.resend(id, owner(app), {
        entryId: Number(input.id),
        text: "Revised notes",
    });

    for (const branch of [fork, retry]) {
        assert.deepEqual(app.sessionMeta(branch.id)?.inheritedUploads, approved);
    }

    const retried = await app.conversation(retry.id);
    const placed = async () =>
        (await retried.entries({}, 32, undefined, context)).items.find(
            (entry) => entry.kind === "pocket.upload-input",
        );

    await until(async () => Boolean(await placed()), "the resend input");
    assert.deepEqual(uploadRefs(await placed()), approved);
    const tasks = await app.harness.commit(
        (tx) => tx.scanTasks({ conversationId: retry.id, kind: "pocket.resend" }, 2),
        context,
    );

    assert.equal(tasks.items.length, 1);
    const task = tasks.items[0]!.input as { uploads: string[]; uploadsApproved?: boolean };

    assert.deepEqual(task.uploads, approved);
    assert.equal(task.uploadsApproved, true);
});

test("an old resend task retains its text but cannot reuse a different input's grant", async () => {
    const id = await newSession(app);
    const user = owner(app);
    const file = upload(id, "meeting.txt");
    const refs = [`${id}/${file.name}`];
    const source = await app.conversation(id);
    const seed = await source.submit({ type: "input", content: "Opening note" }, context);

    await seed.wait(context);
    const answer = (await source.entries({}, 32, undefined, context)).items.find(
        (entry) => entry.kind === "pi.assistant",
    )!;
    const fork = (await app.commands.fork(id, user, { entryId: Number(answer.id) })).id;
    const conversation = await app.conversation(fork);
    const text = "Recovered meeting note";

    await issueUpload(app, id, file);
    // The old fork has a grant for another note, not for the message the task will place.
    const task = await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(fork)]!.inheritedUploads = refs;

        return tx.createTask(
            app.commands.resendTask,
            { text, by: user.id, uploads: refs },
            {
                ownership: { kind: "conversation" },
                background: true,
                conversationId: fork,
            },
        );
    }, context);

    await app.harness.waitForTask(task, context);
    const other = await conversation.submit(
        { type: "input", content: "Separate meeting attachment", ...uploadInput(refs) },
        context,
    );

    await other.wait(context);
    const entries = (await conversation.entries({}, 32, undefined, context)).items;
    const recovered = entries.find((entry) => userContent(entry.model?.[0]).text === text);
    const separate = entries.find(
        (entry) => userContent(entry.model?.[0]).text === "Separate meeting attachment",
    );

    assert.ok(recovered);
    assert.ok(separate && Number(separate.id) > Number(recovered.id));
    assert.deepEqual(app.sessionMeta(fork)?.inheritedUploads, refs);
    assert.deepEqual(uploadRefs(separate), refs);
    assert.deepEqual(uploadRefs(recovered), []);
    const retry = await app.commands.resend(fork, user, { entryId: Number(recovered.id) });

    assert.deepEqual(app.sessionMeta(retry.id)?.inheritedUploads ?? [], []);
});
