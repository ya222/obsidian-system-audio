import esbuild from "esbuild";
import { builtinModules } from "module";

await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
	format: "cjs",
	platform: "node",
	target: "es2022",
	logLevel: "info",
	outfile: "main.js",
});
