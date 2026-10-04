/** Errors the server reports to clients, and helpers for checking what clients send. */

/** An error with the HTTP status the client gets. Anything else becomes a 500. */
export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** A request field that must be text when present: a wrong type is a 400 for the client, not a TypeError and a 500. */
export function optionalText(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new HttpError(400, `${name} must be text`);
	return value;
}

/** The message of anything thrown. */
export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
