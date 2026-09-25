/**
 * autothink — sets the thinking level per prompt from a TypeSafe Jev classification.
 *
 *   /autothink            show status
 *   /autothink on|off     toggle for this session
 *
 * Fails open: if Jev is unavailable the current level is kept.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EFFORT_QUESTION, effortState, pickLevel, shouldClassify } from "../src/autothink.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { choice, evaluate, logDecision } from "../src/jev.ts";
import { tail, textOf } from "../src/transcript.ts";

function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "message" && e.message.role === "assistant") return tail(textOf(e.message.content), 1500);
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	let cfg: Config | null = null;
	let enabled = true;

	const status = (ctx: ExtensionContext, text?: string) =>
		ctx.ui.setStatus("autothink", text ? ctx.ui.theme.fg("dim", text) : undefined);

	pi.on("session_start", async (_e, ctx) => {
		cfg = loadConfig(ctx.cwd);
		enabled = cfg.autothink.enabled;
		status(ctx, enabled ? "🧠auto" : undefined);
	});

	pi.on("input", async (event, ctx) => {
		if (!cfg || !enabled || event.source !== "interactive" || event.streamingBehavior) return;
		if (!shouldClassify(event.text) || !ctx.model?.reasoning) return;

		const prompt = event.text.trim();
		const result = await evaluate(cfg.typesafe, effortState(prompt, lastAssistantText(ctx)), [EFFORT_QUESTION]);
		const answer = result && choice(result.answers, "effort");
		if (!result || !answer) {
			status(ctx, "🧠auto: unavailable");
			return;
		}
		const level = pickLevel(answer, cfg.autothink.confidenceFloor);
		const previous = pi.getThinkingLevel();
		pi.setThinkingLevel(level);
		status(ctx, `🧠auto ${Math.round(answer.confidence * 100)}% ${result.latencyMs}ms`);
		void logDecision(cfg.typesafe, {
			ext: "autothink",
			prompt: tail(prompt, 300),
			answer,
			applied: level,
			previous,
			latencyMs: result.latencyMs,
			model: result.model,
		});
	});

	pi.registerCommand("autothink", {
		description: "Auto-set thinking level per prompt via TypeSafe Jev: on | off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				status(ctx, enabled ? "🧠auto" : undefined);
			}
			ctx.ui.notify(`autothink: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
