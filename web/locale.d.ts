// Types for web/locale.js, which the server and the browser both read.
export type LocaleMessages = Readonly<Record<string, string>>;
export type LocaleValues = Readonly<Record<string, string | number>>;

export declare function placeholders(text: string): string[];
export declare function format(text: string, values?: LocaleValues): string;
export declare function translate(
    messages: LocaleMessages,
    key: string,
    english: string,
    values?: LocaleValues,
): string;
