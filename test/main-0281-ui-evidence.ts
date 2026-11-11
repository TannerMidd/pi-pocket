// Small evidence writer for the fixed-main browser regressions; screenshots are binary JPEG.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserPage } from "../src/server/browser/page.ts";

export async function capture0281(
    page: BrowserPage,
    name: string,
    entry: string,
    selector: string,
) {
    const directory = process.env.PI_POCKET_MAIN_0281_EVIDENCE_DIR;

    if (!directory) {
        return;
    }

    const actual = JSON.parse(
        await page.evaluate(
            `const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing evidence target');return JSON.stringify({width:innerWidth,height:innerHeight,language:document.documentElement.lang,text:node.textContent.replace(/\\s+/g,' ').trim()});`,
        ),
    );
    const shot = await page.screenshot();
    const image = Buffer.from(shot.data, "base64");

    assert.equal(image.readUInt16BE(0), 0xffd8, "a screenshot must be JPEG bytes");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, name + ".jpg"), image);
    writeFileSync(
        join(directory, name + ".json"),
        JSON.stringify(
            {
                entry,
                selector,
                ...actual,
                screenshot: name + ".jpg",
                captureWidth: shot.width,
                captureHeight: shot.height,
            },
            null,
            2,
        ),
    );
}
