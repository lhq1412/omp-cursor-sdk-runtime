import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveStoreRoot, storeRootForScope, __testUtils as storeTestUtils } from "../../src/store.ts";

test("a populated journal root wins only while the recomputed root is empty", () => {
	const root = mkdtempSync(join(tmpdir(), "csr-store-"));
	storeTestUtils.setStateRoot(() => join(root, "sdk-parent"));
	try {
		const computed = storeRootForScope("/tmp/proj", "scope-a");
		const other = storeRootForScope("/tmp/proj", "scope-b");
		expect(other).not.toBe(computed);
		const journal = join(root, "journal");
		mkdirSync(journal, { recursive: true });
		writeFileSync(join(journal, "agent.jsonl"), "{}\n");
		expect(resolveStoreRoot("/tmp/proj", "scope-a", journal)).toBe(journal);
		expect(existsSync(computed)).toBe(false);
		expect(resolveStoreRoot("/tmp/proj", "scope-a", journal)).toBe(journal);
		expect(resolveStoreRoot("/tmp/proj", "scope-b", join(root, "missing"))).toBe(other);
		mkdirSync(computed, { recursive: true });
		writeFileSync(join(computed, "live.jsonl"), "{}\n");
		storeTestUtils.resetCache();
		expect(resolveStoreRoot("/tmp/proj", "scope-a", journal)).toBe(computed);
	} finally {
		storeTestUtils.reset();
	}
});
