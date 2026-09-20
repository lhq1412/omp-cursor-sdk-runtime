import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "../helpers/resume-crash-child.ts");
const CUTPOINTS = [
	"in-flight",
	"send-entered",
	"tool-executed",
	"tool-result-persisted",
	"checkpoint-updated",
	"turn-committed",
	"host-binding-committed",
	"resume-committed",
] as const;

interface RecoverReport {
	cutpoint: string;
	latestState?: string;
	matchingAgentId?: string;
	savedAgentId?: string;
	toolCount: number;
	promptKind: "incremental" | "bootstrap" | "none";
}

function runChild(mode: "write" | "recover", root: string, cutpoint: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CHILD, mode, root, cutpoint], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (mode === "write" && stdout.includes(`REACHED ${cutpoint}`)) {
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`cutpoint=${cutpoint} mode=${mode} timed out stdout=${stdout} stderr=${stderr}`));
		}, 30_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code });
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

describe("session resume crash cutpoints", () => {
	test.each(CUTPOINTS)("%s write is SIGKILL then recover cold-starts from JSONL", async (cutpoint) => {
		const root = mkdtempSync(join(tmpdir(), `omp-crash-${cutpoint}-`));
		try {
			const write = await runChild("write", root, cutpoint);
			expect(write.stdout, `write stdout=${write.stdout} stderr=${write.stderr}`).toContain(`REACHED ${cutpoint}`);
			expect(write.code).not.toBe(0);

			const recover = await runChild("recover", root, cutpoint);
			expect(recover.code, `recover stdout=${recover.stdout} stderr=${recover.stderr}`).toBe(0);
			const line = recover.stdout.split("\n").find((row) => row.startsWith("RECOVER "));
			expect(line, recover.stdout + recover.stderr).toBeDefined();
			const report = JSON.parse(line!.slice("RECOVER ".length)) as RecoverReport;
			expect(report.cutpoint).toBe(cutpoint);
			if (cutpoint === "resume-committed") {
				expect(report.latestState).toBe("committed");
				expect(report.matchingAgentId).toBeDefined();
				expect(report.savedAgentId).toBe(report.matchingAgentId);
				expect(report.promptKind).toBe("incremental");
			} else if (cutpoint === "in-flight") {
				expect(report.latestState).toBe("in-flight");
				expect(report.matchingAgentId).toBeUndefined();
				expect(report.savedAgentId).toBeUndefined();
			} else if (cutpoint === "tool-result-persisted") {
				expect(report.matchingAgentId).toBeUndefined();
				expect(report.savedAgentId).toBeUndefined();
				expect(report.promptKind).toBe("bootstrap");
				expect(report.toolCount).toBe(1);
			} else if (cutpoint === "tool-executed") {
				expect(report.matchingAgentId).toBeUndefined();
				expect(report.savedAgentId).toBeUndefined();
				expect(report.toolCount).toBe(1);
				const after = JSON.parse(readFileSync(join(root, "tool-count.json"), "utf8")) as { count: number };
				expect(after.count).toBe(2);
			} else {
				expect(report.matchingAgentId).toBeUndefined();
				expect(report.savedAgentId).toBeUndefined();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
