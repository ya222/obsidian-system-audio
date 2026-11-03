// Process helpers shared by capture and transcription. No Obsidian imports.

import { spawn } from "child_process";

// Obsidian's AppImage points LD_LIBRARY_PATH at its bundled libs. Keep those
// away from system binaries.
export function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const appDir = env.APPDIR;
	if (appDir && env.LD_LIBRARY_PATH) {
		const kept = env.LD_LIBRARY_PATH.split(":").filter((p) => p && !p.startsWith(appDir));
		if (kept.length) env.LD_LIBRARY_PATH = kept.join(":");
		else delete env.LD_LIBRARY_PATH;
	}
	return env;
}

export class CancelledError extends Error {
	constructor() {
		super("Cancelled.");
		this.name = "CancelledError";
	}
}

/** Runs a command to completion. Rejects with its stderr on a non-zero exit. */
export function run(
	cmd: string,
	args: string[],
	opts: { signal?: AbortSignal; onStderr?: (chunk: string) => void } = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(new CancelledError());
			return;
		}
		const child = spawn(cmd, args, { env: childEnv(), stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (c: Buffer) => {
			const s = c.toString();
			stderr = (stderr + s).slice(-4000);
			opts.onStderr?.(s);
		});
		const onAbort = () => child.kill("SIGTERM");
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (err) => {
			opts.signal?.removeEventListener("abort", onAbort);
			reject(new Error(`Could not run ${cmd}: ${err.message}`));
		});
		child.on("close", (code, signal) => {
			opts.signal?.removeEventListener("abort", onAbort);
			if (opts.signal?.aborted) reject(new CancelledError());
			else if (code === 0) resolve();
			else reject(new Error(`${cmd} failed (code ${code}, signal ${signal}): ${stderr.trim()}`));
		});
	});
}
