/**
 * Abort signal utilities — standalone replacements for ptree.combineSignals and untilAborted.
 */

/**
 * Combine an optional parent AbortSignal with an optional timeout into a single AbortSignal.
 * If both are provided, the resulting signal aborts when either fires.
 */
export function combineSignals(parent?: AbortSignal | null, timeoutMs?: number): AbortSignal | undefined {
	const signals: AbortSignal[] = [];
	if (parent) signals.push(parent);
	if (timeoutMs != null && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
	if (signals.length === 0) return undefined;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}

/**
 * Run an async function, racing it against an AbortSignal.
 * If the signal fires before the function completes, rejects with an AbortError.
 */
export async function untilAborted<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	if (!signal) return fn();
	if (signal.aborted) throw new DOMException("Aborted", "AbortError");

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		fn().then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}
