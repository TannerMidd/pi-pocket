/** Mermaid diagrams and inline math render with local browser libraries. */
import type { ExtensionWeb, PocketHost } from "../host.ts";

export default function (_host: PocketHost, web: ExtensionWeb): void {
    web.client("diagrams", { access: "view" });
}
