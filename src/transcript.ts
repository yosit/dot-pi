/** Helpers for pulling plain text out of pi messages without depending on exact content unions. */

type ContentPart = { type: string; text?: string };
type AnyMessage = { role?: string; content?: unknown };

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ContentPart[])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

/** Last message with the given role, or undefined. */
export function lastByRole<T extends AnyMessage>(messages: readonly T[], role: string): T | undefined {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === role) return messages[i];
	return undefined;
}

/** Whether an assistant message contains any tool call. */
export function hasToolCall(message: AnyMessage | undefined): boolean {
	return Array.isArray(message?.content) && (message.content as ContentPart[]).some((c) => c?.type === "toolCall");
}

/** Keep the tail: the end of an agent message is where claims and questions live. */
export function tail(text: string, max: number): string {
	return text.length <= max ? text : `…${text.slice(-max)}`;
}
