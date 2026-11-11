// Shared types for the explicit, position-by-position WP4 source review.
import type ts from "typescript";

// The parser sets this property at runtime, but TypeScript does not expose it on SourceFile.
export type SourceFileWithParseDiagnostics = ts.SourceFile & {
    readonly parseDiagnostics: readonly ts.Diagnostic[];
};

export type Status =
    | "translated"
    | "already-wired"
    | "structural-reviewed"
    | "content-excluded"
    | "identifier-excluded";
export type Decision = {
    file: string;
    line: number;
    column: number;
    status: Status;
    producer: string;
    reason: string;
    scopes: string[];
    keys: string[];
    expressions: string[];
};
export type Builder = {
    add(
        file: string,
        positions: string,
        status: Status,
        producer: string,
        reason: string,
        scopes: string[],
        keys?: string[],
        expressions?: string[],
    ): void;
};
