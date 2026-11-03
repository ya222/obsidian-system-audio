// Offline transcription with whisper.cpp (`whisper-cli`). No Obsidian imports.

import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { availableParallelism, tmpdir } from "os";
import { join } from "path";
import { run } from "./proc.ts";

export const AUDIO_EXTENSIONS = ["ogg", "opus", "mp3", "wav", "m4a", "webm", "flac", "3gp"];

export interface Segment {
	/** Milliseconds from the start of the audio. */
	start: number;
	end: number;
	text: string;
}

export interface TranscribeOptions {
	/** Path to a whisper.cpp ggml model. */
	modelPath: string;
	signal?: AbortSignal;
	/** Called with 0-100 as whisper works through the audio. */
	onProgress?: (percent: number) => void;
}

interface WhisperJson {
	transcription: { offsets: { from: number; to: number }; text: string }[];
}

export async function transcribe(audioPath: string, opts: TranscribeOptions): Promise<Segment[]> {
	try {
		await stat(opts.modelPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		throw new Error(`Whisper model not found at ${opts.modelPath}. Set the path in the plugin settings.`);
	}

	const dir = await mkdtemp(join(tmpdir(), "obsidian-transcribe-"));
	try {
		// whisper.cpp wants 16 kHz mono PCM.
		const wav = join(dir, "audio.wav");
		await run(
			"ffmpeg",
			["-hide_banner", "-loglevel", "error", "-nostdin", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
			{ signal: opts.signal },
		);

		const outBase = join(dir, "out");
		// One thread per physical core is fastest; more threads were slower in testing.
		const threads = Math.max(1, Math.floor(availableParallelism() / 2));
		await run(
			"whisper-cli",
			["-m", opts.modelPath, "-f", wav, "-l", "en", "-t", String(threads), "-np", "-pp", "-oj", "-of", outBase],
			{
				signal: opts.signal,
				onStderr: (chunk) => {
					for (const m of chunk.matchAll(/progress =\s*(\d+)%/g)) opts.onProgress?.(Number(m[1]));
				},
			},
		);

		const json = JSON.parse(await readFile(`${outBase}.json`, "utf8")) as WhisperJson;
		return json.transcription
			.map((s) => ({ start: s.offsets.from, end: s.offsets.to, text: s.text.trim() }))
			.filter((s) => s.text);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function clock(ms: number, withHours: boolean): string {
	const secs = Math.floor(ms / 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	const mmss = `${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
	return withHours ? `${Math.floor(secs / 3600)}:${mmss}` : mmss;
}

/** Renders segments as a collapsed callout, one timestamped line per segment. */
export function formatTranscript(segments: Segment[]): string {
	if (!segments.length) return "> [!quote]- Transcript\n> (No speech detected.)";
	const withHours = segments[segments.length - 1].start >= 3600_000;
	const lines = segments.map((s) => `> [${clock(s.start, withHours)}] ${s.text}`);
	return ["> [!quote]- Transcript", ...lines].join("\n");
}

/**
 * Inserts a transcript block on the line after the first occurrence of embed.
 * If the embed is gone, appends the block at the end and reports foundEmbed: false.
 */
export function insertTranscript(text: string, embed: string, block: string): { text: string; foundEmbed: boolean } {
	const idx = text.indexOf(embed);
	if (idx === -1) return { text: `${text.replace(/\n*$/, "")}\n\n${block}\n`, foundEmbed: false };
	const lineEnd = text.indexOf("\n", idx + embed.length);
	const at = lineEnd === -1 ? text.length : lineEnd;
	// The trailing newline leaves a blank line so the next paragraph stays out of the callout.
	return { text: `${text.slice(0, at)}\n${block}\n${text.slice(at)}`, foundEmbed: true };
}
