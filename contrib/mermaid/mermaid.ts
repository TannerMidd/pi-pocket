/** Render Mermaid fences as local diagrams, with their source kept in the chat. */
import type { Host, Web } from "./_pocket.d.ts";

export const pocketApi = 1;

export default function createMermaid(_host: Host, web: Web) {
    web.client("mermaid", { access: "view" });
}
