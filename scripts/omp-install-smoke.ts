import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";

const root = await mkdtemp(join(tmpdir(), "omp-install-smoke-"));
const repo = resolve(import.meta.dir, "..");
const home = join(root, "home");
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".omp", "agent") };
let registry: Server<undefined> | undefined;
for (const key of Object.keys(env)) {
	if (key.startsWith("CURSOR_") || key.startsWith("XDG_") || key === "PI_PROFILE" || key === "PI_CONFIG_DIR") delete env[key];
}
async function run(command: string[], cwd: string): Promise<string> {
	const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	assert.equal(code, 0, `${command.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
	return stdout;
}
try {
	await mkdir(home);
	const packed = JSON.parse(await run(["npm", "pack", "--json", "--pack-destination", root], repo));
	const tarball = join(root, packed[0].filename);
	await run(["tar", "-xzf", tarball, "-C", root], root);
	const artifact = join(root, "package");
	await run(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], artifact);
	const host = join(artifact, "node_modules", "@oh-my-pi", "pi-coding-agent");
	const manifest = await Bun.file(join(artifact, "package.json")).json();
	assert.equal((await Bun.file(join(host, "package.json")).json()).version, manifest.dependencies["@oh-my-pi/pi-coding-agent"]);
	let servedTarball = false;
	const tarballPath = `/${manifest.name}/-/${packed[0].filename}`;
	registry = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === `/${manifest.name}`) {
				return Response.json({
					name: manifest.name,
					"dist-tags": { latest: manifest.version },
					versions: {
						[manifest.version]: {
							...manifest,
							dist: { tarball: `${url.origin}${tarballPath}` },
						},
					},
				});
			}
			if (url.pathname === tarballPath) {
				servedTarball = true;
				return new Response(Bun.file(tarball));
			}
			return Response.redirect(`https://registry.npmjs.org${url.pathname}${url.search}`, 307);
		},
	});
	env.BUN_INSTALL_CACHE_DIR = join(root, "bun-cache");
	env.NPM_CONFIG_REGISTRY = registry.url.toString();
	await Bun.write(join(home, ".npmrc"), `registry=${registry.url}\n`);
	const cli = join(host, "dist", "cli.js");
	await run([process.execPath, cli, "plugin", "install", `${manifest.name}@${manifest.version}`], home);
	assert.equal(servedTarball, true, "plugin manager must install the packed artifact from the isolated registry");
	const installed = JSON.parse(await run([process.execPath, cli, "plugin", "list", "--json"], home));
	const plugin = installed.npm.find((item: { name: string }) => item.name === manifest.name);
	assert.ok(plugin, "real plugin manager must list installed package");
	assert.equal((await lstat(plugin.path)).isSymbolicLink(), false, "packed plugin install must not be a local link");
	const pluginRootManifest = await Bun.file(join(home, ".omp", "plugins", "package.json")).json();
	assert.equal(typeof pluginRootManifest.dependencies[manifest.name], "string");
	// Run the installed host's loader in a clean process, never the checkout's imports.
	const verify = join(root, "verify.ts");
	await Bun.write(verify, `
import assert from "node:assert/strict";
import { loadExtensions } from ${JSON.stringify(join(host, "src/extensibility/extensions/loader.ts"))};
import { getAllPluginExtensionPaths } from ${JSON.stringify(join(host, "src/extensibility/plugins/loader.ts"))};
const paths = await getAllPluginExtensionPaths(${JSON.stringify(home)});
assert.ok(paths.some(p => p.includes(${JSON.stringify(manifest.name)})), "installed plugin must be discovered without explicit extension paths");
const result = await loadExtensions(paths, ${JSON.stringify(home)});
assert.deepEqual(result.errors, []);
assert.equal(result.runtime.pendingProviderRegistrations.filter(p => p.name === "cursor-sdk" && p.config.api === "cursor-sdk-agent").length, 1);
console.log("PASS installed extension factory registers cursor-sdk provider");
`);
	console.log((await run([process.execPath, verify], home)).trim());
	console.log(`PASS real OMP ${manifest.dependencies["@oh-my-pi/pi-coding-agent"]} plugin install of npm-packed artifact`);
} finally {
	registry?.stop(true);
	await rm(root, { recursive: true, force: true });
}
