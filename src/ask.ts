import type { ChoiceAnswer, ChoiceQuestion } from "./jev.ts";

export const ASK_QUESTION: ChoiceQuestion = {
	id: "endsWith",
	type: "choice",
	instructions:
		"How does `message` end? Judge only its final sentences, where the agent hands control back to the user.",
	options: [
		{
			value: "statement",
			description: "A report, summary, or result with no question to the user. Rhetorical questions count here.",
		},
		{
			value: "offer",
			description: "A yes/no offer or permission question, e.g. 'Want me to commit this?' or 'Should I push?'",
		},
		{
			value: "decision",
			description: "Asks the user to pick between named alternatives, approaches, or options",
		},
		{
			value: "clarification",
			description: "Asks the user for missing information or to clarify an ambiguous requirement",
		},
	],
};

export function askVerdict(answer: ChoiceAnswer | null, threshold: number, toolName: string): string | null {
	if (!answer || answer.choice === "statement") return null;
	if ((answer.probabilities[answer.choice] ?? 0) < threshold) return null;
	return `[settle-gate · ask] You ended with a plain-text ${answer.choice} question. Ask it through the \`${toolName}\` tool instead: give 2-4 concrete options, mark the one you recommend first, and keep your summary above it. Do not repeat the rest of your message.`;
}
