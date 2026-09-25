/**
 * settle-gate — checks the agent's final message before it hands control back.
 *
 * Two rules, one Jev call (both read the same final message):
 *   verify  — claims "done" / "tests pass" while files changed after the last
 *             verification run, or the last run failed → sends it back to verify.
 *   ask     — ends with a plain-text offer/decision/clarification question
 *             → sends it back to ask through the AskUserQuestion tool.
 *
 * At most one nudge per user prompt, so it can never loop. Fails open.
 *
 *   /settle-gate            show status
 *   /settle-gate on|off     toggle for this session
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_QUESTION, askVerdict } from "../src/ask.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { choice, evaluate, logDecision, noul, type Question } from "../src/jev.ts";
import { hasToolCall, lastByRole, tail, textOf } from "../src/transcript.ts";
import { CLAIM_QUESTIONS, VerifyTracker, verifyVerdict } from "../src/verify.ts";

export default function (pi: ExtensionAPI) {
	let cfg: Config | null = null;
	let tracker: VerifyTracker | null = null;
	let enabled = true;
	let nudgedThisPrompt = false;

	pi.on("session_start", async (_e, ctx) => {
		cfg = loadConfig(ctx.cwd);
		tracker = new VerifyTracker(cfg.settleGate.verify.commands);
		enabled = cfg.settleGate.verify.enabled || cfg.settleGate.ask.enabled;
	});

	pi.on("input", async () => {
		nudgedThisPrompt = false;
	});

	pi.on("tool_result", async (e) => {
		tracker?.onToolResult(e.toolName, e.input, e.isError);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!cfg || !tracker || !enabled || nudgedThisPrompt) return;
		if (event.outcome !== "completed" || event.continue) return; // someone else already continues

		const final = lastByRole(event.context.llmMessages, "assistant");
		if (!final || hasToolCall(final)) return;
		const message = tail(textOf(final.content), 2500);
		if (!message.trim()) return;

		const { verify: verifyCfg, ask: askCfg } = cfg.settleGate;
		const checkVerify = verifyCfg.enabled && tracker.needsReview();
		const checkAsk = askCfg.enabled && ctx.hasUI && pi.getActiveTools().includes(askCfg.toolName);
		if (!checkVerify && !checkAsk) return;

		const questions: Question[] = [...(checkVerify ? CLAIM_QUESTIONS : []), ...(checkAsk ? [ASK_QUESTION] : [])];
		const result = await evaluate(cfg.typesafe, { message }, questions, ctx.signal);
		if (!result) return;

		const verify = checkVerify
			? verifyVerdict(
					tracker,
					{ complete: noul(result.answers, "claimsComplete"), checksPass: noul(result.answers, "claimsChecksPass") },
					verifyCfg.threshold,
				)
			: null;
		const ask =
			!verify && checkAsk ? askVerdict(choice(result.answers, "endsWith"), askCfg.threshold, askCfg.toolName) : null;
		const nudge = verify?.message ?? ask;

		void logDecision(cfg.typesafe, {
			ext: "settle-gate",
			message: tail(message, 400),
			answers: result.answers,
			facts: {
				unverifiedEdits: tracker.unverifiedEdits(),
				standingFailure: tracker.standingFailure(),
				lastVerify: tracker.lastVerify,
			},
			action: verify ? `verify:${verify.reason}` : ask ? "ask" : "none",
			latencyMs: result.latencyMs,
			model: result.model,
		});
		if (!nudge) return;

		nudgedThisPrompt = true;
		ctx.ui.notify(verify ? "settle-gate: sent back to verify" : `settle-gate: sent back to use ${askCfg.toolName}`, "info");
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "dot-pi:settle-gate", content: nudge, display: true },
			],
			continue: true,
		};
	});

	pi.registerCommand("settle-gate", {
		description: "Verification + AskUserQuestion gate at the end of each run: on | off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") enabled = arg === "on";
			ctx.ui.notify(`settle-gate: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
