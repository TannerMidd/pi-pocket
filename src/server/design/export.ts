/** Portable bundle, screenshot, print, and image-slide presentation exports. */
import { basename } from "node:path";
import type { PocketHost } from "../host.ts";
import { writeExport } from "./files.ts";
import type { DesignBundle } from "./bundle.ts";
import { pptx } from "./pptx.ts";
import {
    type DesignViewport,
    SLIDE_SIZE,
    type TweakValues,
    viewportOf,
    withRender,
} from "./render.ts";
import { zip } from "../zip.ts";

export type ExportFormat = "png" | "pdf" | "pptx" | "html";
export const EXPORT_TYPES = {
    png: { extension: "png", mime: "image/png" },
    pdf: { extension: "pdf", mime: "application/pdf" },
    pptx: {
        extension: "pptx",
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    html: { extension: "zip", mime: "application/zip" },
} as const;

type SaveDesignOptions = {
    id: string;
    format: ExportFormat;
    cwd: string;
    viewport?: string | DesignViewport;
    path?: string;
    tweaks?: TweakValues;
    colorScheme?: "light" | "dark";
    theme?: string;
    /** For a deck's PNG: the slide (from 1, default 1), or `all` for a zip with a PNG of every slide. */
    slide?: number | "all";
    signal?: AbortSignal;
};

type ExportView = {
    tweaks?: TweakValues;
    slide?: number | "all";
    colorScheme?: "light" | "dark";
    theme?: string;
};

/** The pixel ratio of PPTX slide images: 2, but no side over 4096 pixels. */
function pptxScale(slide: DesignViewport): number {
    return Math.max(1, Math.min(2, 4096 / Math.max(slide.width, slide.height)));
}

/** Shared file preparation for the agent tool and JSON workspace route. */
export async function saveDesignExport(
    bundle: DesignBundle,
    options: SaveDesignOptions,
    host: PocketHost,
): Promise<{ path: string; name: string; size: number }> {
    const slides = options.format === "png" && options.slide === "all";
    const bytes = await exportDesign(
        bundle,
        options.format,
        options.viewport,
        host,
        options.signal,
        {
            tweaks: options.tweaks,
            slide: options.slide,
            colorScheme: options.colorScheme,
            theme: options.theme,
        },
    );

    options.signal?.throwIfAborted();
    const target =
        options.path ??
        (slides
            ? `exports/${options.id}-v${bundle.version}-slides.zip`
            : `exports/${options.id}-v${bundle.version}.${EXPORT_TYPES[options.format].extension}`);
    const path = await writeExport(options.cwd, target, bytes);

    return { path, name: basename(path), size: bytes.length };
}

export async function exportDesign(
    bundle: DesignBundle,
    format: ExportFormat,
    viewport: string | DesignViewport | undefined,
    host: PocketHost,
    signal?: AbortSignal,
    view: ExportView = {},
): Promise<Buffer> {
    signal?.throwIfAborted();

    if (view.slide !== undefined && format !== "png") {
        throw new Error("The slide option is for the PNG export of a deck.");
    }

    if (format === "html") {
        const names = new Set(bundle.assets.map((asset) => asset.name));
        let entry = "index.html";
        let suffix = 0;

        while (names.has(entry)) {
            entry = `pocket-design${suffix === 0 ? "" : `-${suffix}`}.html`;
            suffix++;
        }

        return zip([{ name: entry, bytes: Buffer.from(bundle.content) }, ...bundle.assets]);
    }

    return withRender(bundle, host, signal, async (page) => {
        const size = format === "pptx" ? SLIDE_SIZE : viewportOf(viewport);

        await page.load(size);
        await page.applyView({
            // Light unless a mode says otherwise: an export does not follow the server's own preference.
            colorScheme: view.colorScheme ?? "light",
            theme: view.theme,
            forceTheme: view.theme !== undefined,
            tweaks: view.tweaks,
        });
        await page.evaluate(`document.title = ${JSON.stringify(bundle.meta.title)}`);

        if (format === "png") {
            const deck = await page.isDeck();

            if (!deck && view.slide !== undefined) {
                throw new Error("The slide option needs a deck.");
            }

            if (!deck) {
                return Buffer.from(await page.screenshot(size, true), "base64");
            }

            const slideSize = await page.slideSize();

            if (view.slide === "all") {
                const count = (await page.slides()).length;
                const pad = String(count).length;
                const files: { name: string; bytes: Buffer }[] = [];
                let total = 0;

                for (let slide = 1; slide <= count; slide++) {
                    await page.showSlide(slide);
                    const bytes = Buffer.from(await page.screenshot(slideSize), "base64");

                    total += bytes.length;

                    if (total > 100_000_000) {
                        throw new Error("The slide images exceed 100 MB.");
                    }

                    files.push({ name: `slide-${String(slide).padStart(pad, "0")}.png`, bytes });
                }

                return zip(files);
            }

            await page.showSlide(view.slide ?? 1);

            return Buffer.from(await page.screenshot(slideSize), "base64");
        }

        if (format === "pdf") {
            return Buffer.from(await page.pdf(size), "base64");
        }

        const texts = await page.slides();
        const slideSize = await page.slideSize();
        const slides: { image: Buffer; text: string }[] = [];
        let total = 0;

        await page.setScale(size, pptxScale(slideSize));

        for (const [index, text] of texts.entries()) {
            await page.showSlide(index + 1);
            const image = Buffer.from(await page.screenshot(slideSize), "base64");

            total += image.length;

            if (total > 100_000_000) {
                throw new Error("The presentation images exceed 100 MB.");
            }

            slides.push({ image, text });
        }

        return pptx(slides, slideSize);
    });
}
