import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultSdkStateRoot, type ModelListItem } from "@cursor/sdk";

const MAX_CACHE_BYTES = 2 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f]/.test(value);
}

/** Copy only SDK model selection data, never arbitrary response properties. */
export function validatedModelItems(value: unknown): ModelListItem[] {
	if (!Array.isArray(value) || value.length > 1000) throw new Error("invalid model catalog");
	if (value.length === 0) throw new Error("empty model catalog");
	const ids = new Set<string>();
	return value.map((model): ModelListItem => {
		if (!record(model) || !text(model.id) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model.id) || !text(model.displayName) || ids.has(model.id)) {
			throw new Error("invalid model catalog entry");
		}
		ids.add(model.id);
		const parameters = new Set<string>();
		if (model.parameters !== undefined && !Array.isArray(model.parameters)) throw new Error("invalid model parameters");
		const cleanParameters = (model.parameters ?? []).map((parameter: unknown) => {
			if (!record(parameter) || !text(parameter.id) || parameters.has(parameter.id) || !Array.isArray(parameter.values)) throw new Error("invalid model parameter");
			const values = new Set<string>();
			const cleanValues = parameter.values.map((entry: unknown) => {
				if (!record(entry) || typeof entry.value !== "string" || values.has(entry.value)) throw new Error("invalid model parameter value");
				values.add(entry.value);
				return { value: entry.value };
			});
			parameters.add(parameter.id);
			return { id: parameter.id, values: cleanValues };
		});
		if (model.variants !== undefined && !Array.isArray(model.variants)) throw new Error("invalid model variants");
		let defaults = 0;
		const variants = (model.variants ?? []).map((variant: unknown) => {
			if (!record(variant) || !Array.isArray(variant.params) || !text(variant.displayName) || (variant.isDefault !== undefined && typeof variant.isDefault !== "boolean")) throw new Error("invalid model variant");
			if (variant.isDefault && ++defaults > 1) throw new Error("ambiguous default model variant");
			const used = new Set<string>();
			// SDK presets contain valid params independently of the advertised parameter definitions.
			const params = variant.params.map((param: unknown) => {
				if (!record(param) || !text(param.id) || typeof param.value !== "string" || used.has(param.id)) throw new Error("invalid model variant parameter");
				used.add(param.id);
				return { id: param.id, value: param.value };
			});
			return { params, displayName: variant.displayName, ...(variant.isDefault !== undefined ? { isDefault: variant.isDefault } : {}) };
		});
		return { id: model.id, displayName: model.displayName, parameters: cleanParameters, variants };
	});
}

export function modelCacheRoot(): string {
	return join(getDefaultSdkStateRoot(process.cwd()), "omp-cursor-runtime", "model-cache");
}

function privateOwned(stat: Stats): boolean {
	return (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid());
}

export async function readModelCache(root: string, credential: string): Promise<ModelListItem[] | undefined> {
	try {
		const directory = await lstat(root);
		if (!directory.isDirectory() || !privateOwned(directory)) return;
		const file = await open(join(root, `${credential}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || !privateOwned(stat) || stat.size > MAX_CACHE_BYTES) return;
			const data: unknown = JSON.parse(await file.readFile("utf8"));
			if (!record(data) || data.version !== 1 || data.credential !== credential) return;
			return validatedModelItems(data.models);
		} finally {
			await file.close();
		}
	} catch {
		return undefined;
	}
}

export async function writeModelCache(root: string, credential: string, models: ModelListItem[]): Promise<void> {
	let temporary: string | undefined;
	try {
		const content = JSON.stringify({ version: 1, credential, models });
		if (Buffer.byteLength(content) > MAX_CACHE_BYTES) return;
		await mkdir(root, { recursive: true, mode: 0o700 });
		const directory = await lstat(root);
		if (!directory.isDirectory() || !privateOwned(directory)) return;
		const path = join(root, `${credential}.json`);
		let mode = 0o600;
		try {
			const existing = await lstat(path);
			if (!existing.isFile() || !privateOwned(existing)) return;
			mode &= existing.mode;
		} catch (error) {
			if (!record(error) || error.code !== "ENOENT") return;
		}
		temporary = join(root, `.${credential}.${randomUUID()}.tmp`);
		const file = await open(temporary, "wx", mode);
		try {
			await file.writeFile(content, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} catch {
		// Persistence is optional; successful live discovery remains usable.
	} finally {
		if (temporary) await unlink(temporary).catch(() => undefined);
	}
}
