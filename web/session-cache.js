/**
 * Sessions this browser keeps on the device (IndexedDB), for every tab of it: a session opened before shows at once after
 * a reload, a tab the system closed, or a restart of the server that runs the same code. `store.js` decides what goes in
 * and checks what comes out (whose it is, which code made it, whether the person may still see it); the server checks
 * the rest (`have`). Every call here may fail (a private window, storage that is full or refused): the cache is only
 * ever a head start, so a failure counts as nothing kept.
 *
 * Two stores, by conversation id: `views` holds each session's view, `info` what to keep or drop it by, small enough to
 * read all of at once: `{ id, owner, build, size, usedAt }`.
 */

const NAME = "pocket-sessions";

let opening;

function database() {
    opening ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(NAME, 1);

        request.onupgradeneeded = () => {
            request.result.createObjectStore("views");
            request.result.createObjectStore("info");
        };

        request.onsuccess = () => {
            const db = request.result;

            // Another tab deletes or upgrades it: let go, and open it again when next needed.
            db.onversionchange = () => {
                db.close();
                opening = undefined;
            };

            resolve(db);
        };

        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("The session cache is open in an older tab"));
    }).catch((error) => {
        opening = undefined;

        throw error;
    });

    return opening;
}

const done = (transaction) =>
    new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });

const result = (request) =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

/**
 * Keep a session's view: `record` is `{ view, place, seen }` as `store.js` keeps it in memory, `info` is
 * `{ owner, build, size }`. Then drop the sessions used longest ago until what is kept fits in `limit` (JSON characters,
 * as `size` counts them).
 */
export async function save(id, record, info, limit) {
    const db = await database();
    const transaction = db.transaction(["views", "info"], "readwrite");
    const all = transaction.objectStore("info");

    transaction.objectStore("views").put(record, id);
    all.put({ id, ...info, usedAt: Date.now() }, id);
    const kept = await result(all.getAll());
    let total = kept.reduce((sum, each) => sum + each.size, 0);

    for (const each of kept.sort((a, b) => a.usedAt - b.usedAt)) {
        if (total <= limit) {
            break;
        }

        all.delete(each.id);
        transaction.objectStore("views").delete(each.id);
        total -= each.size;
    }

    await done(transaction);
}

/**
 * A session as kept (`{ info, record }`), marked as used now unless `touch` is false (read ahead, not opened); undefined
 * if none is.
 */
export async function read(id, touch = true) {
    const db = await database();
    const transaction = db.transaction(["views", "info"], touch ? "readwrite" : "readonly");
    const [info, record] = await Promise.all([
        result(transaction.objectStore("info").get(id)),
        result(transaction.objectStore("views").get(id)),
    ]);

    if (touch && info !== undefined && record !== undefined) {
        transaction.objectStore("info").put({ ...info, usedAt: Date.now() }, id);
    }

    await done(transaction);

    return info === undefined || record === undefined ? undefined : { info, record };
}

/** Drop the sessions for which `drops(info)` is true. */
export async function drop(drops) {
    const db = await database();
    const transaction = db.transaction(["views", "info"], "readwrite");

    for (const info of await result(transaction.objectStore("info").getAll())) {
        if (drops(info)) {
            transaction.objectStore("info").delete(info.id);
            transaction.objectStore("views").delete(info.id);
        }
    }

    await done(transaction);
}

/** Drop every session kept. */
export async function clear() {
    if (typeof indexedDB === "undefined") {
        return;
    }

    const db = await database();
    const transaction = db.transaction(["views", "info"], "readwrite");

    transaction.objectStore("views").clear();
    transaction.objectStore("info").clear();
    await done(transaction);
}

/** What is kept, without the views: `info` of each session. */
export async function list() {
    const db = await database();

    return result(db.transaction("info").objectStore("info").getAll());
}
