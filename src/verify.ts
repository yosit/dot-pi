import type { NoulQuestion } from "./jev.ts";

/**
 * Tracks, in code, the facts a "done" claim must be checked against:
 * did the agent edit files after the last verification run, and did that
 * run pass. Jev only reads the final message; it never judges the facts.
 */
export class VerifyTracker {
	private seq = 0;
	lastEditSeq = -1;
	lastVerify: { seq: number; ok: boolean; command: string } | null = null;
	private readonly patterns: RegExp[];

	constructor(commands: string[]) {
		this.patterns = commands.map((c) => new RegExp(c));
	}

	isVerifyCommand(command: string): boolean {
		return this.patterns.some((p) => p.test(command));
	}

	onToolResult(toolName: string, input: Record<string, unknown>, isError: boolean): void {
		const seq = ++this.seq;
		if ((toolName === "edit" || toolName === "write") && !isError) {
			this.lastEditSeq = seq;
		} else if (toolName === "bash" && typeof input.command === "string" && this.isVerifyCommand(input.command)) {
			this.lastVerify = { seq, ok: !isError, command: input.command };
		}
	}

	/** Files changed and no verification ran after the change. */
	unverifiedEdits(): boolean {
		return this.lastEditSeq >= 0 && (this.lastVerify === null || this.lastVerify.seq < this.lastEditSeq);
	}

	/** The most recent verification run failed and nothing was edited since (so the failure still stands). */
	standingFailure(): boolean {
		return this.lastVerify !== null && !this.lastVerify.ok && this.lastEditSeq < this.lastVerify.seq;
	}

	/** Worth asking Jev at all? Skips the network call when there is nothing to catch. */
	needsReview(): boolean {
		return this.unverifiedEdits() || this.standingFailure();
	}
}

export const CLAIM_QUESTIONS: NoulQuestion[] = [
	{
		id: "claimsComplete",
		type: "noul",
		instructions:
			"`message` tells the user that the requested code change is finished, done, implemented, or fixed.",
		whenTrue: "It reports the work as complete",
		whenFalse: "It reports progress, a plan, a question, a blocker, or unfinished work",
	},
	{
		id: "claimsChecksPass",
		type: "noul",
		instructions: "`message` states that tests, type checks, lint, or the build passed or are green.",
		whenTrue: "It says checks pass",
		whenFalse: "It does not say checks pass, or says they fail or were not run",
	},
];

export type VerifyVerdict = { reason: "unverified" | "false-pass"; message: string } | null;

export function verifyVerdict(
	tracker: VerifyTracker,
	claims: { complete: number | null; checksPass: number | null },
	threshold: number,
): VerifyVerdict {
	const complete = (claims.complete ?? 0) >= threshold;
	const checksPass = (claims.checksPass ?? 0) >= threshold;
	if (tracker.standingFailure() && checksPass) {
		return {
			reason: "false-pass",
			message: `[settle-gate · verify] Your last verification run failed (\`${tracker.lastVerify?.command}\`), but your message says checks pass. Fix the failure and re-run it, or report the failure plainly with the relevant output.`,
		};
	}
	if (tracker.unverifiedEdits() && (complete || checksPass)) {
		const last = tracker.lastVerify
			? `the last verification (\`${tracker.lastVerify.command}\`) ran before your latest edits.`
			: "no verification command has run since you changed files.";
		return {
			reason: "unverified",
			message: `[settle-gate · verify] You are reporting the work as done, but ${last} Run the project's verification gate now and report the actual result. If it cannot run, name the blocker.`,
		};
	}
	return null;
}
