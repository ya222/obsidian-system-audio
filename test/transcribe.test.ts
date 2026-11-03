// End-to-end tests with the real whisper.cpp CLI and the installed model.
// test/fixtures/jfk.wav is the public-domain sample from the whisper.cpp repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CancelledError } from "../src/proc.ts";
import { formatTranscript, insertTranscript, transcribe } from "../src/transcribe.ts";

const run = promisify(execFile);
const modelPath = process.env.WHISPER_MODEL ?? join(homedir(), ".local/share/whisper-models/ggml-medium.en-q5_0.bin");
const fixture = join(import.meta.dirname, "fixtures/jfk.wav");

/** Makes a file shaped like the plugin's recordings: speech, silence, speech, as 48 kHz stereo Opus. */
async function makeRecording(dir: string): Promise<string> {
	const out = join(dir, "recording.ogg");
	await run("ffmpeg", [
		"-hide_banner", "-loglevel", "error",
		"-i", fixture,
		"-f", "lavfi", "-t", "20", "-i", "anullsrc=r=16000:cl=mono",
		"-i", fixture,
		"-filter_complex", "[0][1][2]concat=n=3:v=0:a=1",
		"-ar", "48000", "-ac", "2", "-c:a", "libopus", "-b:a", "96k", out,
	]);
	return out;
}

test("transcribes a recording with timestamps and progress", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "transcribe-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const audio = await makeRecording(dir);

	const progress: number[] = [];
	const segments = await transcribe(audio, { modelPath, onProgress: (p) => progress.push(p) });
	t.diagnostic(JSON.stringify(segments));

	const line = /ask not what your country can do for you,? ask what you can do for your country/i;
	assert.equal(segments.length, 2, "one segment per spoken clip, nothing invented in the silence");
	assert.match(segments[0].text, line);
	assert.match(segments[1].text, line);
	assert.ok(segments[0].start < 1000, `first clip starts at 0 s, got ${segments[0].start}`);
	assert.ok(Math.abs(segments[1].start - 31000) < 1500, `second clip starts near 31 s, got ${segments[1].start}`);
	assert.equal(progress.at(-1), 100);

	const md = formatTranscript(segments);
	assert.match(md, /^> \[!quote\]- Transcript\n> \[00:00\] And so my fellow Americans/);
	assert.match(md, /\n> \[00:3[01]\] /);
});

test("cancelling stops whisper and rejects with CancelledError", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "transcribe-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const audio = await makeRecording(dir);

	const controller = new AbortController();
	const job = transcribe(audio, {
		modelPath,
		signal: controller.signal,
		onProgress: () => undefined,
	});
	setTimeout(() => controller.abort(), 3000);
	await assert.rejects(job, CancelledError);

	const left = (() => {
		try {
			return execFileSync("pgrep", ["-f", `whisper-cli.*${dir}`]).toString();
		} catch {
			return ""; // pgrep exits 1 when nothing matches
		}
	})();
	assert.equal(left, "", "whisper-cli still running after cancel");
});

test("a missing model gives a clear error", async () => {
	const missing = join(tmpdir(), `no-such-model-${process.pid}.bin`);
	await assert.rejects(transcribe(fixture, { modelPath: missing }), {
		message: `Whisper model not found at ${missing}. Set the path in the plugin settings.`,
	});
});

test("transcript goes under its embed and does not swallow the next paragraph", () => {
	const block = "> [!quote]- Transcript\n> [00:00] Hello.";
	const note = "# Meeting\n\n![[a.ogg]]\nNext paragraph.\n";
	assert.deepEqual(insertTranscript(note, "![[a.ogg]]", block), {
		text: "# Meeting\n\n![[a.ogg]]\n> [!quote]- Transcript\n> [00:00] Hello.\n\nNext paragraph.\n",
		foundEmbed: true,
	});
	assert.deepEqual(insertTranscript("![[a.ogg]]", "![[a.ogg]]", block), {
		text: "![[a.ogg]]\n> [!quote]- Transcript\n> [00:00] Hello.\n",
		foundEmbed: true,
	});
	assert.deepEqual(insertTranscript("Embed was deleted.\n\n", "![[a.ogg]]", block), {
		text: "Embed was deleted.\n\n> [!quote]- Transcript\n> [00:00] Hello.\n",
		foundEmbed: false,
	});
});
