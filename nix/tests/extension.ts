import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () => {
    const marker = join(process.env.PI_POCKET_DIR!, "runtime-probe.json");

    // both runners poll this marker while the extension loads
    writeFileSync(
        `${marker}.tmp`,
        JSON.stringify({ pid: process.pid, version: "v1" }),
    );
    renameSync(`${marker}.tmp`, marker);

    return defineExtension({
        name: "runtime-v1",
        tools: [
            defineTool({
                name: "probe_v1",
                description: "Identify the installed extension version",
                parameters: Type.Object({}),
                execute: async () => ({
                    content: [{ type: "text", text: "v1" }],
                }),
            }),
        ],
    });
};
