// Pi Pocket's docs: Starlight, at https://tannermidd.github.io/pi-pocket/docs/, beside the product site (site/).
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import { idOf, pages, REPO, repoMarkdown, VERSION } from "./src/repo-docs.mjs";
import { SIDEBAR } from "./src/sidebar.mjs";

const listed = new Set(SIDEBAR.flatMap((group) => group.items.map(([path]) => path)));
const problems = [];

for (const path of pages()) {
    if (!listed.has(path)) {
        problems.push(`${path} is a page, but not in the sidebar (docs-site/src/sidebar.mjs)`);
    }
}

for (const path of listed) {
    if (!existsSync(join(REPO, path))) {
        problems.push(`${path} is in the sidebar, but not in the repository`);
    }
}

if (problems.length > 0) {
    throw new Error(`The sidebar and the pages differ:\n${problems.join("\n")}`);
}

const sidebar = SIDEBAR.map(({ label, collapsed, items }) => ({
    label,
    collapsed: collapsed ?? false,
    items: items.map(([path, text]) => ({ slug: idOf(path), label: text })),
}));

export default defineConfig({
    site: "https://tannermidd.github.io",
    base: "/pi-pocket/docs",
    trailingSlash: "always",
    devToolbar: { enabled: false },
    markdown: {
        processor: satteri({ mdastPlugins: [repoMarkdown] }),
    },
    vite: {
        // Pages and components get Pi Pocket's version this way: what they import is bundled, away from the repo.
        define: { __POCKET_VERSION__: JSON.stringify(VERSION) },
        server: { fs: { allow: [REPO] } },
    },
    integrations: [
        {
            // A copy of the public types beside the docs, for editors outside a Pi Pocket: /pi-pocket/docs/pocket.d.ts.
            name: "pocket-types",
            hooks: {
                "astro:build:done": ({ dir }) => {
                    const types = join(REPO, "types/pocket.d.ts");

                    if (existsSync(types)) {
                        copyFileSync(types, new URL("pocket.d.ts", dir));
                    }
                },
            },
        },
        starlight({
            title: "Pi Pocket docs",
            description:
                "Extend Pi Pocket: give Pi tools, rules, and checks, and add pages, buttons, and commands to the app.",
            logo: { src: "./public/icon.svg", alt: "" },
            favicon: "/icon.svg",
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/TannerMidd/pi-pocket",
                },
            ],
            components: {
                Footer: "./src/components/Footer.astro",
                SocialIcons: "./src/components/SocialIcons.astro",
            },
            customCss: ["./src/styles/pocket.css"],
            markdown: { processedDirs: [REPO] },
            expressiveCode: { defaultProps: { wrap: true } },
            sidebar,
            lastUpdated: false,
            pagination: true,
            credits: false,
            disable404Route: true,
        }),
    ],
});
