export function normalizeSpec(value?: string | null): string;
export function specificationText(value: unknown): string;
export function specificationParts(value: string): string[];
export function withoutSpecAliases<T>(source?: Record<string, T> | null): Record<string, T>;
