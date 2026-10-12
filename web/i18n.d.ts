/** Data-only, explicit UI localization runtime. */
export function setUiLocales(packs: unknown): string;
export function currentLocale(): string;
export function t<T>(
    value: T,
    params?: Record<string, string | number>,
): T extends string ? string : T;
