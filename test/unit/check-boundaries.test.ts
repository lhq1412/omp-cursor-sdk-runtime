import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checker = join(import.meta.dir, "../../scripts/check-boundaries.ts");

async function runChecker(root: string) {
	const process = Bun.spawn(["bun", checker, "--repo-root", root], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

test("deep OMP imports require an allowlisted owner and symbol", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-boundaries-"));
	try {
		await mkdir(join(root, "src"));
		await mkdir(join(root, "scripts"));
		await Promise.all([
			writeFile(join(root, "src/native-history.ts"), [
				'import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";',
				'import { ConversationStateStructureSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";',
				'import { toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";',
			].join("\n")),
			writeFile(join(root, "src/context.ts"), 'import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";'),
			writeFile(join(root, "src/catalog.ts"), 'import { getBundledModel } from "@oh-my-pi/pi-catalog/models";'),
			writeFile(join(root, "scripts/omp-contract-probe.ts"), 'import { buildPiFindResult, buildPiLsResult } from "@oh-my-pi/pi-ai/providers/cursor/exec-modern";'),
		]);

		const allowed = await runChecker(root);
		expect(allowed.exitCode).toBe(0);

		await Promise.all([
			writeFile(join(root, "src/native-history.ts"), 'import { buildGrpcRequest, unownedSymbol } from "@oh-my-pi/pi-ai/providers/cursor";'),
			writeFile(join(root, "src/wrong-owner.ts"), 'import { buildGrpcRequest } from "@oh-my-pi/pi-ai/providers/cursor";'),
			writeFile(join(root, "scripts/omp-contract-probe.ts"), 'import { buildPiFindResult, piOutputText } from "@oh-my-pi/pi-ai/providers/cursor/exec-modern";'),
			writeFile(join(root, "src/unknown.mts"), 'import { unknown } from "@oh-my-pi/pi-utils/private/unknown";'),
			writeFile(join(root, "src/forms.ts"), [
				'import * as Namespace from "@oh-my-pi/pi-catalog/models";',
				'import defaultModel from "@oh-my-pi/pi-catalog/models";',
				'export { getBundledModel } from "@oh-my-pi/pi-catalog/models";',
				'const required = require("@oh-my-pi/pi-catalog/models");',
				'const dynamic = import("@oh-my-pi/pi-catalog/models");',
				'type Imported = import("@oh-my-pi/pi-catalog/models").GeneratedProvider;',
			].join("\n")),
		]);

		const denied = await runChecker(root);
		expect(denied.exitCode).toBe(1);
		expect(denied.stderr).toContain("src/native-history.ts:1: @oh-my-pi/pi-ai/providers/cursor");
		expect(denied.stderr).toContain("src/wrong-owner.ts:1: @oh-my-pi/pi-ai/providers/cursor");
		expect(denied.stderr).toContain("scripts/omp-contract-probe.ts:1: @oh-my-pi/pi-ai/providers/cursor/exec-modern");
		expect(denied.stderr).toContain("src/unknown.mts:1: @oh-my-pi/pi-utils/private/unknown");
		expect(denied.stderr.match(/src\/forms\.ts:\d+:/g)).toHaveLength(6);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
