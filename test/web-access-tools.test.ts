import assert from "node:assert/strict";
import { test } from "node:test";
import createWebAccessExtension from "../src/server/extensions/web-access.ts";
import { WebAccessManager } from "../src/server/web-access.ts";

test("web tools use the host service and research creation is not replay safe", () => {
    const extension = createWebAccessExtension({ webAccess: new WebAccessManager() });

    assert.equal(extension.name, "pocket-web-access");
    assert.deepEqual(
        extension.tools?.map((tool) => tool.name),
        ["web_search", "fetch_content", "web_crawl", "web_research", "web_research_status"],
    );
    assert.notEqual(extension.tools?.find((tool) => tool.name === "web_research")?.replay, "safe");
    assert.equal(
        extension.tools?.find((tool) => tool.name === "web_research_status")?.replay,
        "safe",
    );
});
