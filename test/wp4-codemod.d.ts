// The read-only dictionary codemod used by WP4 audit scripts.
declare module "*/pi-pocket-pr-notes/dictionary/tools/codemod.mjs" {
    interface SourceRecord {
        id?: string;
        file?: string;
        line?: number;
        column?: number;
        rawEnglish?: string;
        decision?: string;
        keys?: string[];
    }

    interface Candidate {
        file: string;
        line: number;
        column: number;
        english: string;
    }

    interface AutomaticCandidate extends Candidate {
        key: string;
        suggestion: string;
    }

    interface ReviewCandidate extends Candidate {
        reason: string;
        key?: string;
    }

    export function analyzeSource(input: {
        file: string;
        source: string;
        records?: SourceRecord[];
        english?: Record<string, string>;
        chinese?: Record<string, string>;
    }): {
        code: string;
        automatic: AutomaticCandidate[];
        manual: ReviewCandidate[];
        unmapped: ReviewCandidate[];
        importAction: "none" | "added" | "merged" | "present";
    };
}
