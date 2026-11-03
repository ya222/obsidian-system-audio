// Captures every audio source on a PulseAudio or PipeWire (pipewire-pulse) system.
//
// A private null sink acts as a mixing bus. Every source on the system gets a
// loopback into that bus: microphones and other inputs directly, and app output
// through each output device's ".monitor" source. ffmpeg records the bus monitor.
// `pactl subscribe` drives hotplug, so devices that appear mid-recording are
// added and devices that disappear are dropped.
//
// No Obsidian imports here, so the integration test can drive this directly.

import { ChildProcess, execFile, spawn } from "child_process";
import { createWriteStream, WriteStream } from "fs";
import { childEnv } from "./proc.ts";

export const CAPTURE_SINK = "obsidian_system_capture";
const CAPTURE_MONITOR = `${CAPTURE_SINK}.monitor`;

interface Source {
	index: string;
	name: string;
}

interface Module {
	id: string;
	name: string;
	args: string;
}

interface Loopback {
	moduleId: string;
	sourceIndex: string;
}

function pactl(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("pactl", args, { env: childEnv() }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`pactl ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
				return;
			}
			resolve(stdout);
		});
	});
}

function parseShort(out: string): string[][] {
	return out
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => l.split("\t"));
}

async function listSources(): Promise<Source[]> {
	const rows = parseShort(await pactl(["list", "short", "sources"]));
	return rows.map(([index, name]) => ({ index, name }));
}

async function listModules(): Promise<Module[]> {
	const rows = parseShort(await pactl(["list", "short", "modules"]));
	return rows.map(([id, name, args = ""]) => ({ id, name, args }));
}

function argValue(args: string, key: string): string | undefined {
	return args.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`))?.[1];
}

/** Modules that belong to the capture bus: its null sink and every loopback into it. */
async function captureModules(): Promise<Module[]> {
	return (await listModules()).filter(
		(m) =>
			(m.name === "module-null-sink" && argValue(m.args, "sink_name") === CAPTURE_SINK) ||
			(m.name === "module-loopback" && argValue(m.args, "sink") === CAPTURE_SINK),
	);
}

/**
 * Unloads capture modules left behind by a previous session that ended without
 * tearing down (for example Obsidian was killed). Returns how many it removed.
 */
export async function removeLeftoverModules(): Promise<number> {
	const mods = await captureModules();
	// Loopbacks first, then the sink they feed.
	mods.sort((a, b) => Number(a.name === "module-null-sink") - Number(b.name === "module-null-sink"));
	for (const m of mods) await pactl(["unload-module", m.id]);
	return mods.length;
}

export interface CaptureOptions {
	/** Called if capture fails after start() resolved. Recording has stopped by then. */
	onError: (err: Error) => void;
	/** Called whenever the set of captured sources changes. */
	onSourcesChanged?: (sources: string[]) => void;
}

export class SystemAudioCapture {
	private loopbacks = new Map<string, Loopback>();
	private subscriber: ChildProcess | null = null;
	private ffmpeg: ChildProcess | null = null;
	private ffmpegExit: Promise<number | null> | null = null;
	private ffmpegStderr = "";
	private file: WriteStream | null = null;
	private fileDone: Promise<void> | null = null;
	private queue: Promise<void> = Promise.resolve();
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	private stopping = false;
	private failed = false;

	private opts: CaptureOptions;

	constructor(opts: CaptureOptions) {
		this.opts = opts;
	}

	get sources(): string[] {
		return [...this.loopbacks.keys()];
	}

	/** Starts recording every source into an Ogg/Opus file at outputPath. */
	async start(outputPath: string): Promise<void> {
		if (process.platform !== "linux") {
			throw new Error("System audio capture needs Linux with PulseAudio or PipeWire.");
		}
		if (this.ffmpeg) throw new Error("Already recording.");

		await pactl([
			"load-module",
			"module-null-sink",
			`sink_name=${CAPTURE_SINK}`,
			'sink_properties=device.description="Obsidian system capture"',
		]);
		try {
			this.subscribe();
			await this.reconcile();
			await this.startFfmpeg(outputPath);
		} catch (err) {
			await this.teardown();
			throw err;
		}
	}

	/** Stops recording and waits until the file is complete. */
	async stop(): Promise<void> {
		if (!this.ffmpeg || this.stopping) return;
		this.stopping = true;
		const ff = this.ffmpeg;
		// "q" makes ffmpeg finish the stream and exit 0.
		ff.stdin?.end("q");
		const code = await this.ffmpegExit;
		await this.fileDone;
		await this.teardown();
		if (code !== 0) {
			throw new Error(`ffmpeg exited with code ${code}: ${this.ffmpegStderr.trim()}`);
		}
	}

	private subscribe(): void {
		const sub = spawn("pactl", ["subscribe"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
		this.subscriber = sub;
		let buf = "";
		sub.stdout.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			if (lines.some((l) => /^Event '(new|remove)' on source #/.test(l))) this.scheduleReconcile();
		});
		sub.on("exit", (code, signal) => {
			if (this.subscriber === sub && !this.stopping) {
				this.fail(new Error(`pactl subscribe exited (code ${code}, signal ${signal}); hotplug tracking lost.`));
			}
		});
	}

	private scheduleReconcile(): void {
		if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
		this.reconcileTimer = setTimeout(() => {
			this.reconcileTimer = null;
			this.reconcile().catch((err: Error) => this.fail(err));
		}, 250);
	}

	/** Brings the loopback set in line with the sources that exist right now. */
	private reconcile(): Promise<void> {
		const run = async () => {
			if (this.stopping) return;
			const current = new Map(
				(await listSources()).filter((s) => s.name !== CAPTURE_MONITOR).map((s) => [s.name, s.index]),
			);
			let changed = false;

			for (const [name, lb] of this.loopbacks) {
				// Gone, or replaced by a new device with the same name. PipeWire keeps the
				// loopback module around after its source disappears, so unload it here.
				if (current.get(name) !== lb.sourceIndex) {
					await pactl(["unload-module", lb.moduleId]);
					this.loopbacks.delete(name);
					changed = true;
				}
			}
			for (const [name, index] of current) {
				if (this.loopbacks.has(name)) continue;
				const out = await pactl([
					"load-module",
					"module-loopback",
					`source=${name}`,
					`sink=${CAPTURE_SINK}`,
					"source_dont_move=true",
					"sink_dont_move=true",
				]);
				this.loopbacks.set(name, { moduleId: out.trim(), sourceIndex: index });
				changed = true;
			}
			if (changed) this.opts.onSourcesChanged?.(this.sources);
		};
		const next = this.queue.then(run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private startFfmpeg(outputPath: string): Promise<void> {
		const ff = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-nostats",
				"-loglevel", "error",
				"-f", "pulse",
				"-name", "Obsidian system capture",
				"-i", CAPTURE_MONITOR,
				"-c:a", "libopus",
				"-b:a", "96k",
				"-f", "ogg",
				// Write to stdout instead of a file so ffmpeg dies of EPIPE if Obsidian does.
				"pipe:1",
			],
			{ env: childEnv(), stdio: ["pipe", "pipe", "pipe"] },
		);
		this.ffmpeg = ff;
		this.ffmpegStderr = "";
		ff.stderr.on("data", (c: Buffer) => {
			this.ffmpegStderr = (this.ffmpegStderr + c.toString()).slice(-4000);
		});
		// Writing "q" to an ffmpeg that already died raises EPIPE here. The exit
		// code carries the real failure, so record it alongside stderr.
		ff.stdin.on("error", (err) => {
			this.ffmpegStderr += `\n(stdin: ${err.message})`;
		});

		const file = createWriteStream(outputPath);
		this.file = file;
		this.fileDone = new Promise((resolve, reject) => {
			file.on("finish", resolve);
			file.on("error", reject);
		});
		ff.stdout.pipe(file);

		this.ffmpegExit = new Promise((resolve) => ff.on("exit", (code) => resolve(code)));
		ff.on("exit", (code) => {
			if (!this.stopping) {
				this.fail(new Error(`ffmpeg stopped unexpectedly (code ${code}): ${this.ffmpegStderr.trim()}`));
			}
		});

		return new Promise((resolve, reject) => {
			ff.once("spawn", resolve);
			ff.once("error", (err) => reject(new Error(`Could not run ffmpeg: ${err.message}`)));
		});
	}

	private fail(err: Error): void {
		if (this.failed || this.stopping) return;
		this.failed = true;
		this.stopping = true;
		this.ffmpeg?.kill("SIGTERM");
		const report = () => this.opts.onError(err);
		this.teardown().then(report, (teardownErr: Error) => {
			report();
			this.opts.onError(teardownErr);
		});
	}

	private async teardown(): Promise<void> {
		this.stopping = true;
		if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
		this.reconcileTimer = null;
		const sub = this.subscriber;
		this.subscriber = null;
		sub?.kill();
		if (this.ffmpeg && this.ffmpeg.exitCode === null && this.ffmpeg.signalCode === null) {
			this.ffmpeg.kill("SIGTERM");
			await this.ffmpegExit;
		}
		this.ffmpeg = null;
		this.file?.end();
		this.file = null;
		await this.queue;
		this.loopbacks.clear();
		await removeLeftoverModules();
	}
}
