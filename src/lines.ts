const lines = (s: string) => (s === "" ? [] : s.split("\n"));

export function lineCount(s: string): number {
	return lines(s).length;
}

/** Added/removed lines for one oldText→newText replacement, ignoring shared leading/trailing lines. */
export function diffCounts(oldText: string, newText: string): [added: number, removed: number] {
	const a = lines(oldText);
	const b = lines(newText);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	return [endB - start, endA - start];
}
