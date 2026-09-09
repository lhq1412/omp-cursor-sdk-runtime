import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FORBIDDEN_IMPORT_PATTERNS } from "../src/constants.ts";

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(path)));
		} else if (entry.name.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

const importLine = /^\s*(?:import|export)\s.+from\s+["']([^"']+)["']/;
const root = join(import.meta.dir, "..", "src");
const files = await walk(root);
const violations: string[] = [];
for (const file of files) {
	if (file.endsWith("/constants.ts")) continue;
	const text = await readFile(file, "utf8");
	for (const line of text.split("\n")) {
		const match = line.match(importLine);
		if (!match) continue;
		for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
			if (match[1].includes(pattern)) {
				violations.push(`${file}: ${pattern}`);
			}
		}
	}
}

if (violations.length > 0) {
	console.error("Forbidden imports:\n" + violations.join("\n"));
	process.exit(1);
}
console.log(`OK ${files.length} source files`);
