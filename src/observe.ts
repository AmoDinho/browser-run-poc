export function exceededCpu(message: string): boolean {
	return /exceeded cpu time limit/i.test(message);
}

export function logEvent(event: string, fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ event, ...fields }));
}
