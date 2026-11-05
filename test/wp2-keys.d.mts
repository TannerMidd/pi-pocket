export declare const DYNAMIC_COUNT_ARGS: unique symbol;

export interface ExtractedCall {
    file: string;
    line: number;
    key: string;
    english: string;
    names: (string | null)[] | typeof DYNAMIC_COUNT_ARGS;
    helper?: "countedText";
}

export interface UnresolvedCall {
    file: string;
    line: number;
    code: string;
}

export declare function calls(
    file: string,
    source: string,
): {
    result: ExtractedCall[];
    unresolved: UnresolvedCall[];
};
