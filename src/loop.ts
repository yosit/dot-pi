import type { ChoiceAnswer, ChoiceQuestion } from "./jev.ts";

export type ToolRecord = { tool: string; input: string; isError: boolean; output: string };

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/** A compact, comparable summary of what a tool call was trying to do. */
export function summarizeInput(tool: string, input: Record<string, unknown>): string {
	if (tool === "bash") return clip(String(input.command ?? ""), 300);
	if (typeof input.path === "string") return input.path;
	return clip(JSON.stringify(input), 300);
}

export class LoopTracker {
	records: ToolRecord[] = [];
	/** Tool results to wait after a nudge before judging again. */
	private cooldown = 0;

	constructor(private readonly window: number, private readonly minErrors: number) {}

	reset(): void {
		this.records = [];
		this.cooldown = 0;
	}

	add(tool: string, input: Record<string, unknown>, isError: boolean, output: string): void {
		this.records.push({ tool, input: summarizeInput(tool, input), isError, output: clip(output, 400) });
		if (this.records.length > this.window * 3) this.records.splice(0, this.records.length - this.window * 3);
		if (this.cooldown > 0) this.cooldown--;
	}

	recent(): ToolRecord[] {
		return this.records.slice(-this.window);
	}

	/** Deterministic: the same failing call three times in a row. No classifier needed. */
	exactRepeat(): ToolRecord | null {
		if (this.cooldown > 0) return null;
		const r = this.records.slice(-3);
		if (r.length < 3 || !r.every((x) => x.isError)) return null;
		return r.every((x) => x.tool === r[0].tool && x.input === r[0].input) ? r[0] : null;
	}

	/** Cheap pre-filter before spending a Jev call. */
	shouldAsk(): boolean {
		if (this.cooldown > 0) return false;
		return this.recent().filter((r) => r.isError).length >= this.minErrors;
	}

	nudged(): void {
		this.cooldown = this.window;
	}
}

export const LOOP_QUESTION: ChoiceQuestion = {
	id: "trajectory",
	type: "choice",
	instructions:
		"`recentToolCalls` are a coding agent's latest tool calls, oldest first, each with its input, whether it errored, and the start of its output. Which describes the trajectory?",
	options: [
		{
			value: "progressing",
			description: "Errors are changing or getting resolved; each attempt uses new information from the previous output",
		},
		{
			value: "exploring",
			description: "Deliberately probing different things (reading, searching, trying distinct hypotheses); errors are expected along the way",
		},
		{
			value: "stuck",
			description: "Repeating the same approach with small variations and hitting the same error again without new information",
		},
	],
};

export function loopVerdict(answer: ChoiceAnswer | null, threshold: number): boolean {
	return !!answer && answer.choice === "stuck" && (answer.probabilities.stuck ?? 0) >= threshold;
}

export const LOOP_NUDGE =
	"[loop-detector] You are repeating an approach that keeps failing with the same error. Stop and step back: state what you have learned from the failures, list two or three different hypotheses for the root cause, and pick the one the evidence supports best before making another attempt. If you are blocked on something only the user can resolve, say so.";
