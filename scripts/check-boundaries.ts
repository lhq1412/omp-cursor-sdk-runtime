import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
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

// Only these pure conversion exports may cross the built-in Cursor boundary.
const nativeHistoryImports: Record<string, string> = {
	"@oh-my-pi/pi-ai/providers/cursor": "buildGrpcRequest",
	"@oh-my-pi/pi-catalog/discovery/cursor-proto": "ConversationStateStructureSchema",
	"@oh-my-pi/pi-catalog/discovery/protobuf": "toBinary",
};
const root = join(import.meta.dir, "..", "src");
const files = await walk(root);
const violations: string[] = [];
for (const file of files) {
	const text = await readFile(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	function check(node: ts.Node): void {
		const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
			? node.moduleSpecifier
			: ts.isCallExpression(node) && (
				node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require")
			)
				? node.arguments[0]
				: ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
					? node.moduleReference.expression
					: undefined;
		if (specifier && ts.isStringLiteralLike(specifier) && FORBIDDEN_IMPORT_PATTERNS.some((pattern) => specifier.text.includes(pattern))) {
			const bindings = ts.isImportDeclaration(node) && !node.importClause?.name ? node.importClause?.namedBindings : undefined;
			const allowedName = nativeHistoryImports[specifier.text];
			const allowed = file === join(root, "native-history.ts") && allowedName &&
				bindings && ts.isNamedImports(bindings) && bindings.elements.length === 1 &&
				(bindings.elements[0]!.propertyName ?? bindings.elements[0]!.name).text === allowedName;
			if (!allowed) {
				violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${specifier.text}`);
			}
		}
		ts.forEachChild(node, check);
	}
	check(source);
}

if (violations.length > 0) {
	console.error("Forbidden imports:\n" + violations.join("\n"));
	process.exit(1);
}
console.log(`OK ${files.length} source files`);
