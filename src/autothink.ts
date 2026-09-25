import type { ChoiceAnswer, ChoiceQuestion } from "./jev.ts";

export type Level = "minimal" | "low" | "medium" | "high";
export const LEVELS: Level[] = ["minimal", "low", "medium", "high"];

export const EFFORT_QUESTION: ChoiceQuestion = {
	id: "effort",
	type: "choice",
	instructions:
		"How much reasoning does a coding agent need before acting on `prompt`? If `prompt` is a short follow-up (e.g. 'yes', 'do it', 'go ahead'), judge the work it approves as described in `previousAssistantMessage`.",
	options: [
		{ value: "minimal", description: "Acknowledgement, chit-chat, or a one-line factual answer; no code change" },
		{ value: "low", description: "A small, mechanical, well-specified edit, lookup, or command" },
		{ value: "medium", description: "A normal feature, bug fix, or explanation touching a few files" },
		{
			value: "high",
			description: "Debugging an unknown cause, cross-cutting refactor, architecture or design decision",
		},
	],
};

export function effortState(prompt: string, previousAssistantMessage: string) {
	return previousAssistantMessage ? { prompt, previousAssistantMessage } : { prompt };
}

/** When Jev is unsure, lean toward more thinking: the highest level holding meaningful probability. */
export function pickLevel(answer: ChoiceAnswer, confidenceFloor: number): Level {
	const top = LEVELS.includes(answer.choice as Level) ? (answer.choice as Level) : "medium";
	if (answer.confidence >= confidenceFloor) return top;
	return [...LEVELS].reverse().find((l) => (answer.probabilities[l] ?? 0) >= 0.25) ?? top;
}

/** Prompts autothink never classifies: commands, shell escapes, empty input. */
export function shouldClassify(text: string): boolean {
	const t = text.trim();
	return t.length > 0 && !t.startsWith("/") && !t.startsWith("!");
}
