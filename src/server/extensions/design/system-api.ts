import type { DesignBundle } from "../../design/bundle.ts";
import { applyExactFixes } from "../../design/fix.ts";
import type { CheckFinding, CheckReport, DesignSystem } from "../../design/system-types.ts";

export { loadDesignSystem, writeDesignSystem } from "../../design/tokens.ts";
export { type CheckOptions, checkDesign } from "../../design/lint.ts";
export { renderSystemDoc } from "../../design/docsite.ts";

type Fix = { rule: CheckFinding["rule"]; from: string; to: string; count: number };

export function fixExactMatches(
    bundle: DesignBundle,
    system: DesignSystem,
    report: CheckReport,
    accepted: ReadonlySet<string>,
): { content: string; fixed: number; fixes: Fix[] } {
    const fixable = report.findings.filter(
        (finding) =>
            finding.fix !== undefined && !(finding.id !== undefined && accepted.has(finding.id)),
    );
    const result = applyExactFixes(bundle.content, fixable, system);
    const skipped = new Set(result.skipped.map((each) => each.id));
    const fixes = new Map<string, Fix>();

    for (const finding of result.applied === 0 ? [] : fixable) {
        if (skipped.has(finding.id ?? "")) {
            continue;
        }

        const { literal, cssVar } = finding.fix!;
        const key = `${literal}\u0000${cssVar}`;
        const known = fixes.get(key);

        if (known === undefined) {
            fixes.set(key, {
                rule: finding.rule,
                from: literal,
                to: `var(${cssVar})`,
                count: 1,
            });
        } else {
            known.count += 1;
        }
    }

    return { content: result.content, fixed: result.applied, fixes: [...fixes.values()] };
}
