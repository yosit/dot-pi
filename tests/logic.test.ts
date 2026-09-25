import { describe, expect, test } from "bun:test";
import { askVerdict } from "../src/ask.ts";
import { pickLevel, shouldClassify } from "../src/autothink.ts";
import { resolveReserve } from "../src/compaction.ts";
import { DEFAULTS, merge } from "../src/config.ts";
import { type ChoiceAnswer, toWire } from "../src/jev.ts";
import { diffCounts, lineCount } from "../src/lines.ts";
import { LoopTracker, loopVerdict } from "../src/loop.ts";
import { hasToolCall, lastByRole, tail, textOf } from "../src/transcript.ts";
import { VerifyTracker, verifyVerdict } from "../src/verify.ts";

const ans = (choice: string, probabilities: Record<string, number>, confidence = probabilities[choice]): ChoiceAnswer => ({
	type: "choice",
	choice,
	confidence,
	probabilities,
});

describe("toWire", () => {
	test("maps choice options to criteria and noul whenTrue/whenFalse", () => {
		expect(
			toWire([
				{ id: "a", type: "choice", instructions: "pick", options: [{ value: "x", description: "X" }, { value: "y" }] },
				{ id: "b", type: "noul", instructions: "true?", whenTrue: "yes" },
				{ id: "c", type: "noul", instructions: "bare" },
			]),
		).toEqual({
			a: { type: "choice", instructions: "pick", criteria: { x: "X", y: null } },
			b: { type: "noul", instructions: "true?", criteria: { true: "yes" } },
			c: { type: "noul", instructions: "bare" },
		});
	});

	test("rejects duplicate ids", () => {
		expect(() => toWire([{ id: "a", type: "noul", instructions: "1" }, { id: "a", type: "noul", instructions: "2" }])).toThrow();
	});
});

describe("autothink", () => {
	test("confident answer is used as-is", () => {
		expect(pickLevel(ans("low", { minimal: 0, low: 0.95, medium: 0.05, high: 0 }), 0.6)).toBe("low");
	});

	test("unsure answer leans to the highest level with meaningful mass", () => {
		expect(pickLevel(ans("medium", { minimal: 0, low: 0.2, medium: 0.5, high: 0.3 }, 0.5), 0.6)).toBe("high");
	});

	test("unknown choice falls back to medium", () => {
		expect(pickLevel(ans("banana", { banana: 1 }), 0.6)).toBe("medium");
	});

	test("skips commands, shell escapes, and empty input", () => {
		expect(shouldClassify("/model")).toBe(false);
		expect(shouldClassify("!ls")).toBe(false);
		expect(shouldClassify("   ")).toBe(false);
		expect(shouldClassify("fix the bug")).toBe(true);
	});
});

describe("VerifyTracker", () => {
	const make = () => new VerifyTracker(DEFAULTS.settleGate.verify.commands);

	test("recognizes verification commands", () => {
		const t = make();
		for (const c of ["bun run check", "bun test", "npm test", "pnpm run lint", "bunx tsc --noEmit", "cargo test", "go test ./...", "pytest -q"]) {
			expect(t.isVerifyCommand(c)).toBe(true);
		}
		for (const c of ["ls", "git status", "cat test.ts", "bun install"]) expect(t.isVerifyCommand(c)).toBe(false);
	});

	test("no edits → nothing to review", () => {
		const t = make();
		t.onToolResult("read", { path: "a" }, false);
		expect(t.needsReview()).toBe(false);
	});

	test("edit with no verification → unverified", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		expect(t.unverifiedEdits()).toBe(true);
	});

	test("failed edits do not count as changes", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, true);
		expect(t.needsReview()).toBe(false);
	});

	test("passing verification after edit clears it", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		t.onToolResult("bash", { command: "bun run check" }, false);
		expect(t.needsReview()).toBe(false);
	});

	test("edit after verification is unverified again", () => {
		const t = make();
		t.onToolResult("bash", { command: "bun run check" }, false);
		t.onToolResult("write", { path: "a" }, false);
		expect(t.unverifiedEdits()).toBe(true);
	});

	test("failed verification with no edit since is a standing failure", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		t.onToolResult("bash", { command: "bun test" }, true);
		expect(t.standingFailure()).toBe(true);
		expect(t.unverifiedEdits()).toBe(false);
	});

	test("verdict: unverified completion claim is sent back", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		expect(verifyVerdict(t, { complete: 0.9, checksPass: 0.1 }, 0.7)?.reason).toBe("unverified");
	});

	test("verdict: claiming a pass over a standing failure is sent back", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		t.onToolResult("bash", { command: "bun test" }, true);
		const v = verifyVerdict(t, { complete: 0.9, checksPass: 0.9 }, 0.7);
		expect(v?.reason).toBe("false-pass");
		expect(v?.message).toContain("bun test");
	});

	test("verdict: honest failure report passes", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		t.onToolResult("bash", { command: "bun test" }, true);
		expect(verifyVerdict(t, { complete: 0.2, checksPass: 0.05 }, 0.7)).toBeNull();
	});

	test("verdict: progress report without claim passes", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		expect(verifyVerdict(t, { complete: 0.3, checksPass: 0.1 }, 0.7)).toBeNull();
	});

	test("verdict: null answers (Jev down) never block", () => {
		const t = make();
		t.onToolResult("edit", { path: "a" }, false);
		expect(verifyVerdict(t, { complete: null, checksPass: null }, 0.7)).toBeNull();
	});
});

describe("askVerdict", () => {
	test("statement passes", () => {
		expect(askVerdict(ans("statement", { statement: 0.9, offer: 0.1 }), 0.75, "AskUserQuestion")).toBeNull();
	});
	test("confident offer is redirected to the tool", () => {
		expect(askVerdict(ans("offer", { statement: 0.1, offer: 0.9 }), 0.75, "AskUserQuestion")).toContain("AskUserQuestion");
	});
	test("low-confidence question passes", () => {
		expect(askVerdict(ans("decision", { statement: 0.4, decision: 0.6 }), 0.75, "AskUserQuestion")).toBeNull();
	});
	test("no answer passes", () => {
		expect(askVerdict(null, 0.75, "AskUserQuestion")).toBeNull();
	});
});

describe("LoopTracker", () => {
	test("detects the same failing call three times", () => {
		const t = new LoopTracker(6, 3);
		for (let i = 0; i < 3; i++) t.add("bash", { command: "bun test foo" }, true, "boom");
		expect(t.exactRepeat()?.input).toBe("bun test foo");
	});

	test("a success in between breaks the repeat", () => {
		const t = new LoopTracker(6, 3);
		t.add("bash", { command: "bun test foo" }, true, "boom");
		t.add("bash", { command: "bun test foo" }, false, "ok");
		t.add("bash", { command: "bun test foo" }, true, "boom");
		expect(t.exactRepeat()).toBeNull();
	});

	test("only asks Jev once enough errors pile up, then cools down", () => {
		const t = new LoopTracker(6, 3);
		t.add("bash", { command: "a" }, true, "e");
		t.add("bash", { command: "b" }, true, "e");
		expect(t.shouldAsk()).toBe(false);
		t.add("bash", { command: "c" }, true, "e");
		expect(t.shouldAsk()).toBe(true);
		t.nudged();
		t.add("bash", { command: "d" }, true, "e");
		expect(t.shouldAsk()).toBe(false);
	});

	test("exact repeat respects the cooldown after a nudge", () => {
		const t = new LoopTracker(6, 3);
		for (let i = 0; i < 3; i++) t.add("bash", { command: "x" }, true, "e");
		t.nudged();
		t.add("bash", { command: "x" }, true, "e");
		expect(t.exactRepeat()).toBeNull();
	});

	test("reset clears history", () => {
		const t = new LoopTracker(6, 3);
		for (let i = 0; i < 3; i++) t.add("bash", { command: "x" }, true, "e");
		t.reset();
		expect(t.exactRepeat()).toBeNull();
	});

	test("verdict needs 'stuck' above threshold", () => {
		expect(loopVerdict(ans("stuck", { stuck: 0.8, progressing: 0.2 }), 0.7)).toBe(true);
		expect(loopVerdict(ans("stuck", { stuck: 0.6, progressing: 0.4 }), 0.7)).toBe(false);
		expect(loopVerdict(ans("exploring", { exploring: 0.9 }), 0.7)).toBe(false);
	});
});

describe("lines", () => {
	test("diffCounts ignores shared context lines", () => {
		expect(diffCounts("a\nb\nc", "a\nB\nc")).toEqual([1, 1]);
		expect(diffCounts("a\nc", "a\nb\nc")).toEqual([1, 0]);
		expect(diffCounts("", "x\ny")).toEqual([2, 0]);
	});
	test("lineCount", () => {
		expect(lineCount("")).toBe(0);
		expect(lineCount("a\nb")).toBe(2);
	});
});

describe("compaction reserve", () => {
	test("model override beats setting beats default", () => {
		expect(resolveReserve({}, {}, "anthropic/x")).toBe(16384);
		expect(resolveReserve({ reserveTokens: 1000 }, {}, "anthropic/x")).toBe(1000);
		expect(resolveReserve({ reserveTokens: 1000, modelOverrides: { "anthropic/x": { reserveTokens: 600000 } } }, {}, "anthropic/x")).toBe(600000);
	});
	test("project overrides user; disabled returns null", () => {
		expect(resolveReserve({ reserveTokens: 1000 }, { reserveTokens: 2000 }, "m")).toBe(2000);
		expect(resolveReserve({}, { enabled: false }, "m")).toBeNull();
	});
});

describe("config merge", () => {
	test("deep merges objects and replaces arrays", () => {
		const cfg = merge(DEFAULTS, { settleGate: { verify: { commands: ["make ci"] } }, autothink: { enabled: false } });
		expect(cfg.settleGate.verify.commands).toEqual(["make ci"]);
		expect(cfg.settleGate.verify.threshold).toBe(0.7);
		expect(cfg.settleGate.ask.toolName).toBe("AskUserQuestion");
		expect(cfg.autothink.enabled).toBe(false);
		expect(cfg.typesafe.model).toBe(DEFAULTS.typesafe.model);
	});
});

describe("transcript helpers", () => {
	test("textOf, lastByRole, hasToolCall, tail", () => {
		const msgs = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall" }] },
			{ role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "done" }] },
		];
		const last = lastByRole(msgs, "assistant");
		expect(textOf(last?.content)).toBe("done");
		expect(hasToolCall(last)).toBe(false);
		expect(hasToolCall(msgs[1])).toBe(true);
		expect(tail("abcdef", 3)).toBe("…def");
	});
});
