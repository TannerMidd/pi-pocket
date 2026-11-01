/**
 * A short fingerprint of a string, the same in the browser and on the server (which imports this file). It names what
 * a tab already has (`have` in `web/store.js`, `Room.push`): equal fingerprints say the server's copy is the tab's.
 * 53 bits of cyrb53, as base 36: not for secrets, only to tell copies apart.
 */
export function fingerprint(text) {
    let a = 0xdeadbeef;
    let b = 0x41c6ce57;

    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);

        a = Math.imul(a ^ code, 2654435761);
        b = Math.imul(b ^ code, 1597334677);
    }

    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);

    return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}
