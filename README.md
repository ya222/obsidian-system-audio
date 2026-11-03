# System Audio Capture

An Obsidian plugin for Linux that records all of your computer's audio, every microphone plus everything apps play, into one file in your vault. It can then transcribe the recording offline with Whisper.

## Features

- Records every input and output device at once, including devices you plug in mid-recording.
- Leaves your default devices and what you hear unchanged.
- Saves an Ogg/Opus file to your attachments folder and embeds it in the open note.
- Transcribes locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Nothing leaves your machine.

## Requirements

- Linux with PipeWire (`pipewire-pulse`) or PulseAudio
- `pactl` and `ffmpeg` with `libopus`
- For transcription: `whisper-cli` (on Ubuntu, `sudo apt install whisper.cpp`) and a [ggml Whisper model](https://huggingface.co/ggerganov/whisper.cpp)

## Install

```sh
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to `<vault>/.obsidian/plugins/system-audio-capture/`, then enable the plugin in **Settings > Community plugins**.

## Use

**Record:** click the waveform icon in the ribbon, or run **Start/stop recording system audio**. The status bar shows the elapsed time. Click it to stop.

**Transcribe:** right-click an audio player or audio file and choose **Transcribe**, or click the CC icon in the ribbon. The transcript goes under the recording's embed as a collapsed callout:

```markdown
![[System audio 20261102143000.ogg]]
> [!quote]- Transcript
> [00:00] And so my fellow Americans, ask not what your country can do for you...
```

Set the model path in the plugin settings. Transcription is English only. With the medium.en model on a 4-core laptop CPU, it takes about half as long as the recording.

## How it works

The plugin creates a private null sink and loops every PulseAudio source into it: each microphone, and each output device's `.monitor`. ffmpeg records the null sink. `pactl subscribe` handles hotplug.

## Development

```sh
npm test
```

The tests are end-to-end against your running audio server and whisper.cpp. They play test tones into temporary virtual devices, so nothing comes out of your speakers. They briefly open your microphone and delete the recording afterward. `test/fixtures/jfk.wav` is the public-domain sample from the whisper.cpp repo.

## License

[MIT](LICENSE)
