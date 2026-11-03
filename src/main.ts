import {
	App,
	EmbedCache,
	FileSystemAdapter,
	MarkdownView,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TAbstractFile,
	TFile,
	getLinkpath,
	normalizePath,
	setIcon,
} from "obsidian";
import { readFile, rm, unlink } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { SystemAudioCapture, removeLeftoverModules } from "./capture.ts";
import { CancelledError } from "./proc.ts";
import { AUDIO_EXTENSIONS, formatTranscript, insertTranscript, transcribe } from "./transcribe.ts";

interface Settings {
	modelPath: string;
}

const DEFAULT_SETTINGS: Settings = {
	modelPath: join(homedir(), ".local/share/whisper-models/ggml-medium.en-q5_0.bin"),
};

interface AudioEmbed {
	embed: EmbedCache;
	audio: TFile;
}

/** Where a transcript goes: under an embed in a note, or (null) into a new note. */
type TranscriptTarget = { note: TFile; embed: string } | null;

const isAudio = (file: TAbstractFile): file is TFile =>
	file instanceof TFile && AUDIO_EXTENSIONS.includes(file.extension.toLowerCase());

const pad = (n: number) => String(n).padStart(2, "0");

function timestamp(d: Date): string {
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function elapsed(secs: number): string {
	const h = Math.floor(secs / 3600);
	const mmss = `${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
	return h ? `${h}:${mmss}` : mmss;
}

export default class SystemAudioPlugin extends Plugin {
	settings: Settings = DEFAULT_SETTINGS;
	private transcribing: AbortController | null = null;
	private transcribeStatus!: HTMLElement;
	private capture: SystemAudioCapture | null = null;
	private tempPath = "";
	private startedAt = 0;
	private busy = false;
	private ribbon!: HTMLElement;
	private status!: HTMLElement;
	private timer: number | null = null;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addSettingTab(new SystemAudioSettingTab(this.app, this));

		this.ribbon = this.addRibbonIcon("audio-lines", "Record system audio", () => this.toggle());
		this.status = this.addStatusBarItem();
		this.status.addClass("system-audio-status");
		this.status.addEventListener("click", () => this.toggle());
		this.status.hide();

		this.addCommand({
			id: "toggle-recording",
			name: "Start/stop recording system audio",
			callback: () => this.toggle(),
		});

		this.transcribeStatus = this.addStatusBarItem();
		this.transcribeStatus.addClass("system-audio-status");
		this.transcribeStatus.setAttr("aria-label", "Click to cancel transcription");
		this.transcribeStatus.addEventListener("click", () => this.transcribing?.abort());
		this.transcribeStatus.hide();

		this.addRibbonIcon("closed-caption", "Transcribe recording", () => this.transcribeFromRibbon());

		this.addCommand({
			id: "transcribe-recording",
			name: "Transcribe recording in this note",
			checkCallback: (checking) => {
				const note = this.app.workspace.getActiveFile();
				if (!note || note.extension !== "md") return false;
				if (!checking) this.pickAndTranscribe(note);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!isAudio(file)) return;
				menu.addItem((mi) =>
					mi
						.setTitle("Transcribe")
						.setIcon("closed-caption")
						.onClick(() => this.transcribeFile(file)),
				);
			}),
		);

		// Obsidian gives audio embeds no context menu, and the player's own "..."
		// menu belongs to Chromium, so right-clicking the player is where this goes.
		const listen = (doc: Document) =>
			this.registerDomEvent(doc, "contextmenu", (evt) => this.onEmbedContextMenu(evt), { capture: true });
		listen(document);
		this.registerEvent(this.app.workspace.on("window-open", (win) => listen(win.doc)));

		// If Obsidian was killed mid-recording, the loopbacks are still loaded and
		// keep the microphones open. Remove them now rather than at the next recording.
		this.app.workspace.onLayoutReady(() => {
			removeLeftoverModules().then(
				(n) => n && new Notice(`System audio: removed ${n} capture modules left by an earlier session.`),
				(err: Error) => this.showError(err),
			);
		});
	}

	onunload(): void {
		if (this.capture) void this.finish();
		this.transcribing?.abort();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private audioEmbeds(note: TFile): AudioEmbed[] {
		const embeds = this.app.metadataCache.getFileCache(note)?.embeds ?? [];
		const found: AudioEmbed[] = [];
		for (const embed of embeds) {
			const audio = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(embed.link), note.path);
			if (audio && isAudio(audio)) found.push({ embed, audio });
		}
		return found;
	}

	private alreadyTranscribing(): boolean {
		if (this.transcribing) new Notice("Already transcribing. Click the status bar item to cancel it.");
		return this.transcribing !== null;
	}

	private pickAndTranscribe(note: TFile): void {
		if (this.alreadyTranscribing()) return;
		const items = this.audioEmbeds(note);
		if (!items.length) {
			new Notice("No audio is embedded in this note.");
			return;
		}
		const go = (item: AudioEmbed) =>
			this.runTranscription(item.audio, { note, embed: item.embed.original }).catch((e: Error) => this.showError(e));
		if (items.length === 1) go(items[0]);
		else new Picker(this.app, items, (i) => i.audio.path, go).open();
	}

	/** Ribbon: recordings in the open note, or else every audio file in the vault, newest first. */
	private transcribeFromRibbon(): void {
		if (this.alreadyTranscribing()) return;
		const active = this.app.workspace.getActiveFile();
		if (active?.extension === "md" && this.audioEmbeds(active).length) {
			this.pickAndTranscribe(active);
			return;
		}
		const files = this.app.vault.getFiles().filter(isAudio).sort((a, b) => b.stat.mtime - a.stat.mtime);
		if (!files.length) {
			new Notice("No audio files in this vault.");
			return;
		}
		new Picker(this.app, files, (f) => f.path, (f) => this.transcribeFile(f)).open();
	}

	private onEmbedContextMenu(evt: MouseEvent): void {
		const el = evt.target instanceof Element ? evt.target.closest(".internal-embed.audio-embed") : null;
		const linktext = el?.getAttribute("src");
		if (!el || !linktext) return;
		const leaf = this.app.workspace
			.getLeavesOfType("markdown")
			.find((l) => l.view instanceof MarkdownView && l.view.containerEl.contains(el));
		const note = leaf?.view instanceof MarkdownView ? leaf.view.file : null;
		const audio = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), note?.path ?? "");
		if (!audio || !isAudio(audio)) return;

		evt.preventDefault();
		evt.stopPropagation();
		new Menu()
			.addItem((mi) =>
				mi
					.setTitle("Transcribe")
					.setIcon("closed-caption")
					.onClick(() => this.transcribeFile(audio, note ?? undefined)),
			)
			.showAtMouseEvent(evt);
	}

	/**
	 * Right-click entry point. The transcript goes under the audio's embed in
	 * inNote (default: the active note), or else in the only note that embeds it,
	 * or else in a new note.
	 */
	private transcribeFile(audio: TFile, inNote?: TFile): void {
		if (this.alreadyTranscribing()) return;
		const embedIn = (note: TFile) => this.audioEmbeds(note).find((e) => e.audio === audio);

		let target: TranscriptTarget = null;
		const active = inNote ?? this.app.workspace.getActiveFile();
		const activeEmbed = active?.extension === "md" ? embedIn(active) : undefined;
		if (active && activeEmbed) {
			target = { note: active, embed: activeEmbed.embed.original };
		} else {
			const notes = Object.entries(this.app.metadataCache.resolvedLinks)
				.filter(([, dests]) => audio.path in dests)
				.map(([path]) => this.app.vault.getFileByPath(path))
				.filter((f): f is TFile => f !== null && embedIn(f) !== undefined);
			if (notes.length === 1) target = { note: notes[0], embed: embedIn(notes[0])!.embed.original };
		}
		this.runTranscription(audio, target).catch((e: Error) => this.showError(e));
	}

	/** Creates "<audio name> transcript.md" in the default new-note folder. */
	private async createTranscriptNote(audio: TFile, block: string): Promise<TFile> {
		const folder = this.app.fileManager.getNewFileParent(audio.path);
		const base = normalizePath(`${folder.path}/${audio.basename} transcript`);
		let path = `${base}.md`;
		for (let n = 1; this.app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`;
		const link = this.app.fileManager.generateMarkdownLink(audio, path);
		return this.app.vault.create(path, `!${link}\n${block}\n`);
	}

	/** Transcribes audio and puts the transcript under its embed in target, or in a new note. */
	private async runTranscription(audio: TFile, target: TranscriptTarget): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("Transcription needs a vault on the local file system.");

		const controller = new AbortController();
		this.transcribing = controller;
		this.setTranscribing(0);
		try {
			const segments = await transcribe(adapter.getFullPath(audio.path), {
				modelPath: this.settings.modelPath,
				signal: controller.signal,
				onProgress: (p) => this.setTranscribing(p),
			});
			const block = formatTranscript(segments);

			if (!target) {
				const note = await this.createTranscriptNote(audio, block);
				// Open it in a background tab so a long job doesn't yank focus.
				await this.app.workspace.getLeaf("tab").openFile(note, { active: false });
				new Notice(`Transcribed ${audio.name} into ${note.path}.`);
				return;
			}

			// The note may have changed during a long transcription, so locate the
			// embed again by its text rather than by its old position.
			let foundEmbed = true;
			await this.app.vault.process(target.note, (text) => {
				const result = insertTranscript(text, target.embed, block);
				foundEmbed = result.foundEmbed;
				return result.text;
			});
			new Notice(
				foundEmbed
					? `Transcribed ${audio.name} into ${target.note.basename}.`
					: `The embed for ${audio.name} is no longer in ${target.note.basename}; added the transcript at the end.`,
			);
		} catch (err) {
			if (err instanceof CancelledError) new Notice("Transcription cancelled.");
			else this.showError(err as Error);
		} finally {
			this.transcribing = null;
			this.transcribeStatus.hide();
		}
	}

	private setTranscribing(percent: number): void {
		this.transcribeStatus.show();
		this.transcribeStatus.setText(`Transcribing ${percent}%`);
	}

	private async toggle(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			if (this.capture) await this.finish();
			else await this.begin();
		} catch (err) {
			this.showError(err as Error);
		} finally {
			this.busy = false;
		}
	}

	private async begin(): Promise<void> {
		const leftover = await removeLeftoverModules();
		if (leftover) new Notice(`System audio: removed ${leftover} capture modules left by an earlier session.`);

		const tempPath = join(tmpdir(), `obsidian-system-audio-${Date.now()}.ogg`);
		const capture = new SystemAudioCapture({
			onError: (err) => {
				if (this.capture !== capture) return;
				this.capture = null;
				this.setIdle();
				this.showError(err);
				void this.saveRecording(tempPath).catch((e: Error) => this.showError(e));
			},
			onSourcesChanged: (sources) => {
				this.status.setAttr("aria-label", `Capturing:\n${sources.join("\n")}`);
			},
		});
		try {
			await capture.start(tempPath);
		} catch (err) {
			await rm(tempPath, { force: true });
			throw err;
		}
		this.capture = capture;
		this.tempPath = tempPath;
		this.startedAt = Date.now();
		this.setRecording();
		new Notice(`Recording system audio from ${capture.sources.length} sources.`);
	}

	private async finish(): Promise<void> {
		const capture = this.capture;
		if (!capture) return;
		this.capture = null;
		this.setIdle();
		try {
			await capture.stop();
		} finally {
			// Save whatever ffmpeg wrote, even if it exited badly.
			await this.saveRecording(this.tempPath);
		}
	}

	/** Moves the temp recording into the vault and embeds it in the active note. */
	private async saveRecording(tempPath: string): Promise<void> {
		const data = await readFile(tempPath);
		if (data.byteLength === 0) {
			await unlink(tempPath);
			throw new Error("Recording is empty; nothing was saved.");
		}

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sourcePath = view?.file?.path ?? "";
		const name = `System audio ${timestamp(new Date())}.ogg`;
		const path = normalizePath(await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath));

		let file: TFile;
		try {
			file = await this.app.vault.createBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
		} catch (err) {
			throw new Error(`Could not save to ${path}: ${(err as Error).message}. The recording is still at ${tempPath}.`);
		}
		await unlink(tempPath);

		if (view?.file) {
			const link = this.app.fileManager.generateMarkdownLink(file, view.file.path);
			view.editor.replaceSelection(`!${link}\n`);
		}
		new Notice(`Saved ${file.path}`);
	}

	private setRecording(): void {
		this.ribbon.addClass("system-audio-recording");
		this.ribbon.setAttr("aria-label", "Stop recording system audio");
		this.status.show();
		const tick = () => {
			const secs = Math.floor((Date.now() - this.startedAt) / 1000);
			this.status.empty();
			setIcon(this.status.createSpan({ cls: "system-audio-dot" }), "circle");
			this.status.createSpan({ text: ` ${elapsed(secs)}` });
		};
		tick();
		this.timer = window.setInterval(tick, 1000);
		this.registerInterval(this.timer);
	}

	private setIdle(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.ribbon.removeClass("system-audio-recording");
		this.ribbon.setAttr("aria-label", "Record system audio");
		this.status.hide();
	}

	private showError(err: Error): void {
		console.error("[system-audio]", err);
		new Notice(`System audio: ${err.message}`, 0);
	}
}

class Picker<T> extends SuggestModal<T> {
	constructor(
		app: App,
		private items: T[],
		private label: (item: T) => string,
		private onPick: (item: T) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a recording to transcribe");
	}

	getSuggestions(query: string): T[] {
		const q = query.toLowerCase();
		return this.items.filter((i) => this.label(i).toLowerCase().includes(q));
	}

	renderSuggestion(item: T, el: HTMLElement): void {
		el.setText(this.label(item));
	}

	onChooseSuggestion(item: T): void {
		this.onPick(item);
	}
}

class SystemAudioSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SystemAudioPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		this.containerEl.empty();
		new Setting(this.containerEl)
			.setName("Whisper model")
			.setDesc("Path to a whisper.cpp ggml model. Transcription is in English.")
			.addText((text) =>
				text.setValue(this.plugin.settings.modelPath).onChange(async (value) => {
					this.plugin.settings.modelPath = value.trim();
					await this.plugin.saveSettings();
				}),
			);
	}
}
