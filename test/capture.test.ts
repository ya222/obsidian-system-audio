// End-to-end test against the real PipeWire/PulseAudio server.
//
// Two temporary null sinks stand in for output devices so nothing plays
// through real speakers. One exists before recording starts, the other is
// plugged in mid-recording. A tone goes into each, and the test checks that
// both tones land in the recorded file at the right times, that the real mic
// and the real speaker monitor were captured too, and that no modules leak.
//
// The real microphone is open while this runs; the recording is deleted after.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CAPTURE_SINK, SystemAudioCapture } from "../src/capture.ts";

const run = promisify(execFile);
const pactl = async (...args: string[]) => (await run("pactl", args)).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await sleep(50);
	}
}

function playTone(sink: string, freq: number, secs: number) {
	return run("ffmpeg", [
		"-hide_banner", "-loglevel", "error",
		"-re", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${secs}:sample_rate=48000`,
		"-f", "pulse", "-device", sink, "test tone",
	]);
}

/** Peak level in dBFS of a narrow band around freq, between from and to seconds. */
async function bandPeak(file: string, freq: number, from: number, to: number): Promise<number> {
	const { stderr } = await run("ffmpeg", [
		"-hide_banner", "-nostats",
		"-ss", String(from), "-t", String(to - from), "-i", file,
		"-af", `bandpass=f=${freq}:width_type=h:w=40,bandpass=f=${freq}:width_type=h:w=40,volumedetect`,
		"-f", "null", "-",
	]);
	const m = stderr.match(/max_volume: (-?[\d.]+|-inf) dB/);
	assert.ok(m, `no volumedetect output:\n${stderr}`);
	return m[1] === "-inf" ? -Infinity : Number(m[1]);
}

test("records mics and every output device, including one plugged in mid-recording", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "system-audio-test-"));
	const out = join(dir, "out.ogg");
	const speakerA = `sa_test_speaker_a_${process.pid}`;
	const speakerB = `sa_test_speaker_b_${process.pid}`;
	const modA = await pactl("load-module", "module-null-sink", `sink_name=${speakerA}`);
	let modB: string | null = null;

	t.after(async () => {
		await pactl("unload-module", modA);
		if (modB) await pactl("unload-module", modB);
		await rm(dir, { recursive: true, force: true });
	});

	const errors: Error[] = [];
	let sources: string[] = [];
	const capture = new SystemAudioCapture({
		onError: (e) => errors.push(e),
		onSourcesChanged: (s) => (sources = s),
	});

	const realSink = await pactl("get-default-sink");
	const realSource = await pactl("get-default-source");

	await capture.start(out);
	const t0 = Date.now();
	const at = () => (Date.now() - t0) / 1000;

	assert.ok(sources.includes(`${speakerA}.monitor`), `speaker A not captured: ${sources}`);
	assert.ok(sources.includes(`${realSink}.monitor`), `real speaker monitor not captured: ${sources}`);
	assert.ok(sources.includes(realSource), `real mic not captured: ${sources}`);
	assert.ok(!sources.includes(`${CAPTURE_SINK}.monitor`), "capture bus must not loop into itself");
	assert.equal(await pactl("get-default-sink"), realSink, "default output must not change");

	await sleep(500);
	const aFrom = at();
	await playTone(speakerA, 440, 2);
	const aTo = at();

	modB = await pactl("load-module", "module-null-sink", `sink_name=${speakerB}`);
	await waitFor(() => sources.includes(`${speakerB}.monitor`), "hotplugged speaker B to be captured");
	await sleep(300);
	const bFrom = at();
	await playTone(speakerB, 1250, 2);
	const bTo = at();

	await pactl("unload-module", modB);
	modB = null;
	await waitFor(() => !sources.includes(`${speakerB}.monitor`), "unplugged speaker B to be dropped");

	await sleep(500);
	await capture.stop();
	assert.deepEqual(errors, []);

	const modules = await pactl("list", "short", "modules");
	assert.ok(!modules.includes(CAPTURE_SINK), `capture modules leaked:\n${modules}`);
	assert.ok((await stat(out)).size > 0, "recording is empty");

	// Trim edges to allow for loopback latency.
	const toneA = await bandPeak(out, 440, aFrom + 0.6, aTo - 0.2);
	const toneB = await bandPeak(out, 1250, bFrom + 0.6, bTo - 0.2);
	const noAinB = await bandPeak(out, 440, bFrom + 0.6, bTo - 0.2);
	t.diagnostic(`440 Hz in A window: ${toneA} dB, 1250 Hz in B window: ${toneB} dB, 440 Hz in B window: ${noAinB} dB`);
	assert.ok(toneA > -30, `tone from speaker A missing (${toneA} dB)`);
	assert.ok(toneB > -30, `tone from hotplugged speaker B missing (${toneB} dB)`);
	assert.ok(noAinB < toneA - 20, `tone A bleeding into B window (${noAinB} dB)`);
});
