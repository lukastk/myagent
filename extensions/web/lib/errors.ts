/**
 * Tool error types — standalone replacements for oh-my-pi tool-errors.
 */

export class ToolError extends Error {
	readonly isToolError = true;
	constructor(message: string) {
		super(message);
		this.name = "ToolError";
	}
}

export class ToolAbortError extends Error {
	readonly isToolAbortError = true;
	constructor(message = "Tool execution aborted") {
		super(message);
		this.name = "ToolAbortError";
	}
}

export function throwIfAborted(signal?: AbortSignal | null): void {
	if (signal?.aborted) throw new ToolAbortError();
}

export function renderError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
