/** Simplified Chinese UI text, selected in Appearance and removed when this module is off. */
import type { ExtensionWeb, PocketHost } from "../host.ts";
import pack from "./zh-cn/messages.ts";

export default function createChinese(_host: PocketHost, web: ExtensionWeb): void {
    if (typeof web.uiLocales === "function") {
        web.uiLocales([pack]);
    }
}
