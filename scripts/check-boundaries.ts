import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { FORBIDDEN_IMPORT_PATTERNS } from "../src/constants.ts";

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(path)));
		} else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

// Implementation subpaths are denied unless this table owns both the file and every imported symbol.
const deepImportOwners: Record<string, Record<string, readonly string[]>> = {
	"@oh-my-pi/pi-ai/providers/cursor": {
		"src/native-history.ts": ["buildGrpcRequest"],
	},
	"@oh-my-pi/pi-ai/providers/cursor-pi-args": {
		"src/sdk-native-hook.ts": [
			"cursorEditOwnedReadPath",
			"omitUndefinedArgs",
			"piGrepSkip",
			"piJoinPath",
			"piLimit",
			"piLsPath",
			"piReadPath",
			"piReadPathHasRange",
		],
		"scripts/omp-contract-probe.ts": [
			"omitUndefinedArgs",
			"piGrepSkip",
			"piJoinPath",
			"piLimit",
			"piLsPath",
			"piReadPath",
			"piReadPathHasRange",
		],
	},
	"@oh-my-pi/pi-catalog/compat/revision": {
		"src/catalog.ts": ["parseRevision", "parseRevisionConstraint", "revisionSatisfies"],
	},
	"@oh-my-pi/pi-catalog/compat/taxonomy": {
		"src/catalog.ts": ["classifyModel"],
		"src/context.ts": ["classifyModel"],
	},
	"@oh-my-pi/pi-catalog/discovery/cursor-proto": {
		"src/native-history.ts": ["ConversationStateStructureSchema"],
		"scripts/omp-contract-probe.ts": [
			"ConversationStateStructureSchema",
			"ConversationStepSchema",
			"ConversationTurnStructureSchema",
			"UserMessageSchema",
		],
	},
	"@oh-my-pi/pi-catalog/discovery/protobuf": {
		"src/native-history.ts": ["toBinary", "pb", "ProtoMessage"],
		"scripts/omp-contract-probe.ts": ["fromBinary", "toBinary"],
	},
	"@oh-my-pi/pi-catalog/models": {
		"src/catalog.ts": ["getBundledModel"],
		"scripts/omp-contract-probe.ts": ["getBundledModel"],
	},
};

function importedNames(node: ts.Node): string[] | undefined {
	if (!ts.isImportDeclaration(node) || node.importClause?.name) return undefined;
	const bindings = node.importClause?.namedBindings;
	if (!bindings || !ts.isNamedImports(bindings)) return undefined;
	return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

const rootFlag = process.argv.indexOf("--repo-root");
const rootArgument = rootFlag >= 0 ? process.argv[rootFlag + 1] : undefined;
if (rootFlag >= 0 && !rootArgument) throw new Error("--repo-root requires a path");
const repoRoot = rootArgument ? resolve(rootArgument) : join(import.meta.dir, "..");
const roots = [join(repoRoot, "src"), join(repoRoot, "scripts")];
const files = (await Promise.all(roots.map(walk))).flat();
const violations: string[] = [];
for (const file of files) {
	const owner = relative(repoRoot, file).replaceAll("\\", "/");
	const text = await readFile(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	function check(node: ts.Node): void {
		const specifier = ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
			? node.argument.literal
			: ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
				? node.moduleSpecifier
				: ts.isCallExpression(node) && (
					node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require")
				)
					? node.arguments[0]
					: ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
						? node.moduleReference.expression
						: undefined;
		if (specifier && ts.isStringLiteralLike(specifier)) {
			const moduleName = specifier.text;
			const isOmpDeepImport = /^@oh-my-pi\/[^/]+\/.+/.test(moduleName);
			const matchesKnownInternal = FORBIDDEN_IMPORT_PATTERNS.some((pattern) => moduleName.includes(pattern));
			if (isOmpDeepImport || matchesKnownInternal) {
				const allowedNames = deepImportOwners[moduleName]?.[owner];
				const names = importedNames(node);
				const allowed = allowedNames && names?.length && names.every((name) => allowedNames.includes(name));
				if (!allowed) {
					const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
					violations.push(`${owner}:${line}: ${moduleName} (owner or imported symbol is not allowlisted)`);
				}
			}
		}
		ts.forEachChild(node, check);
	}
	check(source);
}

if (violations.length > 0) {
	console.error("Forbidden implementation imports:\n" + violations.join("\n"));
	process.exit(1);
}
console.log(`OK ${files.length} source and script files`);
