import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";
import { repoDocsLoader } from "./repo-docs.mjs";

export const collections = {
    docs: defineCollection({ loader: repoDocsLoader(), schema: docsSchema() }),
};
