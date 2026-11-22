export const MAX_DEPTH: number;
export const MAX_ITEMS: number;
export const FUNCTIONS: string[];
export type Scope = {
    data: unknown;
    computed?: Record<string, unknown>;
    row?: unknown;
};
export function isExpr(value: unknown): boolean;
export function pointer(path: unknown): string[] | undefined;
export function readPath(path: unknown, scope: Scope): unknown;
export function bytes(value: unknown): string;
export function textOf(value: unknown): string;
export function evaluate(value: unknown, scope: Scope, depth?: number): unknown;
export function evaluateComputed(
    computed: Record<string, unknown> | undefined,
    data: unknown,
): Record<string, unknown>;
export function checkExpr(value: unknown, depth?: number): string | undefined;
