/**
 * loop-detector — notices when the agent keeps retrying a failing approach
 * and tells it to step back (and raises the thinking level).
 *
 * Deterministic check first (same failing call 3x); Jev only for fuzzy
 * "same thing with small variations" loops, and only after enough errors
 * pile up in the recent window. Cooldown after each nudge. Fails open.
 *
 *   /loop-detector on|off
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Config, loadConfig } from "../src/config.ts";
import { type ChoiceAnswer, choice, evaluate, logDecision } from "../src/jev.ts";
import { LOOP_NUDGE, LOOP_QUESTION, LoopTracker, loopVerdict } from "../src/loop.ts";
import { textOf } from "../src/transcript.ts";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh"];

export default function (pi: ExtensionAPI) {
	let cfg: Config | null = null;
	let tracker: LoopTracker | null = null;
	let enabled = true;

	pi.on("session_start", async (_e, ctx) => {
		cfg = loadConfig(ctx.cwd);
		tracker = new LoopTracker(cfg.loopDetector.window, cfg.loopDetector.minErrors);
		enabled = cfg.loopDetector.enabled;
	});

	pi.on("input", async () => tracker?.reset());

	pi.on("tool_result", async (e) => {
		tracker?.add(e.toolName, e.input, e.isError, textOf(e.content));
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!cfg || !tracker || !enabled || event.toolResults.length === 0) return;

		let reason: "exact-repeat" | "jev-stuck" | null = null;
		if (tracker.exactRepeat()) {
			reason = "exact-repeat";
		} else if (tracker.shouldAsk()) {
			const result = await evaluate(cfg.typesafe, { recentToolCalls: tracker.recent() }, [LOOP_QUESTION], ctx.signal);
			const answer: ChoiceAnswer | null = result && choice(result.answers, "trajectory");
			if (loopVerdict(answer, cfg.loopDetector.threshold)) reason = "jev-stuck";
			void logDecision(cfg.typesafe, {
				ext: "loop-detector",
				recent: tracker.recent(),
				answer,
				action: reason ?? "none",
				latencyMs: result?.latencyMs,
			});
		}
		if (!reason) return;

		tracker.nudged();
		const target = cfg.loopDetector.escalateThinking;
		if (target && ORDER.indexOf(pi.getThinkingLevel()) < ORDER.indexOf(target)) {
			pi.setThinkingLevel(target as ThinkingLevel);
		}
		ctx.ui.notify(`loop-detector: ${reason}, nudging agent`, "warning");
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "dot-pi:loop-detector", content: LOOP_NUDGE, display: true },
			],
		};
	});

	pi.registerCommand("loop-detector", {
		description: "Detect and break failing retry loops: on | off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") enabled = arg === "on";
			ctx.ui.notify(`loop-detector: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
