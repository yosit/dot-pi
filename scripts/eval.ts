/**
 * Live eval: runs labeled examples through the real Jev API and reports
 * whether each extension's question + threshold would act correctly.
 *
 *   bun run eval      (key from TYPESAFE_API_KEY, else the psst vault — see README)
 *
 * Add a failing real-world case here before tuning a threshold.
 */
import { ASK_QUESTION } from "../src/ask.ts";
import { EFFORT_QUESTION, effortState, pickLevel } from "../src/autothink.ts";
import { DEFAULTS } from "../src/config.ts";
import { choice, evaluate, noul } from "../src/jev.ts";
import { LOOP_QUESTION, loopVerdict } from "../src/loop.ts";
import { CLAIM_QUESTIONS } from "../src/verify.ts";

const cfg = { ...DEFAULTS.typesafe, logFile: "" };
let pass = 0;
let fail = 0;
const latencies: number[] = [];

function report(name: string, ok: boolean, detail: string) {
	if (ok) pass++;
	else fail++;
	console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
}

async function run() {
	// autothink
	const effort: [string, string, string[]][] = [
		["thanks!", "", ["minimal"]],
		["rename `fetchUser` to `findOrCreateUser` in src/users.ts", "", ["low"]],
		["add a --json flag to the `vex tables` command", "", ["low", "medium"]],
		["the SSE subscription silently drops query strings after the dedup refactor — find out why and fix it", "", ["high"]],
		["design a per-workspace permission model and a migration plan for existing users", "", ["high"]],
		["yes do it", "I can refactor auth across all 30 plugins to the new actor model and migrate the grants table. Want me to proceed?", ["high"]],
		["yes", "Want me to push the commit?", ["minimal", "low"]],
	];
	for (const [prompt, prev, expected] of effort) {
		const r = await evaluate(cfg, effortState(prompt, prev), [EFFORT_QUESTION]);
		const a = r && choice(r.answers, "effort");
		if (!r || !a) return report(`effort: ${prompt}`, false, "no answer");
		latencies.push(r.latencyMs);
		const level = pickLevel(a, DEFAULTS.autothink.confidenceFloor);
		report(`effort: ${prompt.slice(0, 50)}`, expected.includes(level), `${level} (conf ${a.confidence}) expected ${expected.join("|")}`);
	}

	// settle-gate: claims + endings
	const finals: { msg: string; complete: boolean; checksPass: boolean; ending: string[] }[] = [
		{ msg: "Done. Added the --json flag to `vex tables` and updated the help text.", complete: true, checksPass: false, ending: ["statement"] },
		{ msg: "Fixed — the dedup refactor dropped the query string. All 25 tests pass ✅", complete: true, checksPass: true, ending: ["statement"] },
		{ msg: "I've read through the router. The bug is in `new URL(subPath, origin)`. Next I'll write a failing test.", complete: false, checksPass: false, ending: ["statement"] },
		{ msg: "Tests fail: 3 failures in auth.test.ts (token expiry). I haven't fixed them yet.", complete: false, checksPass: false, ending: ["statement"] },
		{ msg: "Implemented the migration. Want me to commit and push?", complete: true, checksPass: false, ending: ["offer"] },
		{ msg: "Two options: keep the adapter in-process, or move it to a worker. Which do you prefer?", complete: false, checksPass: false, ending: ["decision"] },
		{ msg: "Which workspace should the new sensor attach to? I don't see one named 'ops'.", complete: false, checksPass: false, ending: ["clarification"] },
	];
	for (const f of finals) {
		const r = await evaluate(cfg, { message: f.msg }, [...CLAIM_QUESTIONS, ASK_QUESTION]);
		if (!r) return report(`final: ${f.msg}`, false, "no answer");
		latencies.push(r.latencyMs);
		const t = DEFAULTS.settleGate.verify.threshold;
		const complete = (noul(r.answers, "claimsComplete") ?? 0) >= t;
		const checksPass = (noul(r.answers, "claimsChecksPass") ?? 0) >= t;
		const ending = choice(r.answers, "endsWith");
		const label = f.msg.slice(0, 50);
		report(`claimsComplete: ${label}`, complete === f.complete, `${noul(r.answers, "claimsComplete")} expected ${f.complete}`);
		report(`claimsChecksPass: ${label}`, checksPass === f.checksPass, `${noul(r.answers, "claimsChecksPass")} expected ${f.checksPass}`);
		report(`endsWith: ${label}`, !!ending && f.ending.includes(ending.choice), `${ending?.choice} (${ending?.confidence}) expected ${f.ending.join("|")}`);
	}

	// loop-detector
	const stuck = [
		{ tool: "bash", input: "bun test tests/auth.test.ts", isError: true, output: "TypeError: Cannot read properties of undefined (reading 'token') at auth.ts:42" },
		{ tool: "edit", input: "src/auth.ts", isError: false, output: "Successfully replaced 1 block" },
		{ tool: "bash", input: "bun test tests/auth.test.ts", isError: true, output: "TypeError: Cannot read properties of undefined (reading 'token') at auth.ts:43" },
		{ tool: "edit", input: "src/auth.ts", isError: false, output: "Successfully replaced 1 block" },
		{ tool: "bash", input: "bun test tests/auth.test.ts --bail", isError: true, output: "TypeError: Cannot read properties of undefined (reading 'token') at auth.ts:44" },
	];
	const progressing = [
		{ tool: "bash", input: "bun run check", isError: true, output: "src/a.ts(3,1): error TS2304: Cannot find name 'foo'. 4 errors" },
		{ tool: "edit", input: "src/a.ts", isError: false, output: "Successfully replaced 1 block" },
		{ tool: "bash", input: "bun run check", isError: true, output: "src/b.ts(9,5): error TS2345: Argument of type 'string'... 2 errors" },
		{ tool: "edit", input: "src/b.ts", isError: false, output: "Successfully replaced 1 block" },
		{ tool: "bash", input: "bun run check", isError: true, output: "knip: unused export `bar` in src/c.ts. 1 error" },
	];
	for (const [name, calls, expectStuck] of [["stuck", stuck, true], ["progressing", progressing, false]] as const) {
		const r = await evaluate(cfg, { recentToolCalls: calls }, [LOOP_QUESTION]);
		const a = r && choice(r.answers, "trajectory");
		if (!r || !a) return report(`loop: ${name}`, false, "no answer");
		latencies.push(r.latencyMs);
		const verdict = loopVerdict(a, DEFAULTS.loopDetector.threshold);
		report(`loop: ${name}`, verdict === expectStuck, `${a.choice} ${JSON.stringify(a.probabilities)}`);
	}
}

await run();
latencies.sort((a, b) => a - b);
const p50 = latencies[Math.floor(latencies.length / 2)];
console.log(`\n${pass} pass, ${fail} fail · ${latencies.length} calls · p50 ${p50}ms · max ${latencies.at(-1)}ms`);
process.exit(fail ? 1 : 0);
