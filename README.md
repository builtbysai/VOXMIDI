# VOXMIDI

**Your voice is the instrument.** Hum, sing, or whistle into your mic and play any synth in real time. Beatbox the drums. Send the MIDI straight to your DAW. Zero install, runs entirely in the browser.

Live: https://builtbysai.github.io/VOXMIDI/

## What it does

- **Voice to MIDI, live.** Monophonic pitch tracking (YIN) turns humming, singing, or whistling into MIDI notes about 80 times a second, with velocity from your loudness and optional pitch bend that follows your voice.
- **Stay in key.** Snap notes to 14 scales (the Dubler 2 idea, without the $99 box): Major, Natural/Harmonic/Melodic Minor, the modes, pentatonics, Blues, Whole Tone, Chromatic.
- **Beatbox drums.** Onset detection plus spectral classification sorts your mouth sounds into kick, snare, and hat. Everyone beatboxes differently, so you can **train each pad** to your own sounds; your templates are saved on the device.
- **Real MIDI output.** Pick a MIDI device and drive a DAW or hardware synth (Chrome, Edge, or Firefox). No device? The built-in synth plays, and you can still record.
- **Record to MIDI file.** Capture a session and download a standard `.mid` (Type 0) for your DAW. Drums land on channel 10, like they should.
- **Guided setup.** Mic permission is explained before the browser asks, with a live level meter, input device picker, and a hum-a-note check so you know it hears you.

## Run it

No build step, no dependencies. Serve the folder over HTTP (mic access needs a secure context: `https` or `localhost`):

```sh
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` straight from disk works for looking around, but the mic needs `http(s)`.

## How it works

- `js/pitch.js` — YIN pitch detection plus a debounced monophonic note tracker (no note flutter). Pure DSP, unit-tested in node.
- `js/drums.js` — streaming onset detector (log-energy flux vs. adaptive median threshold) plus a 3-zone classifier: spectral centroid and band-energy ratios matched against per-pad templates with nearest-neighbor distance. Trainable.
- `js/engine.js` — mic graph (`getUserMedia` → `AnalyserNode`), 80 fps analysis loop, Web MIDI output, internal Web Audio synth (mono lead + kick/snare/hat), session recorder.
- `js/midifile.js` — session events to a Standard MIDI File. Tested byte-for-byte.
- `js/ui.js`, `css/app.css`, `index.html` — onboarding wizard and studio.

## Honest limits

- **Monophonic only.** One note at a time: whistle, hum, or sing a single line. Chords are out of scope.
- **Mic quality matters.** A laptop mic in a noisy room tracks worse than a headset mic in a quiet one. The sensitivity slider is there for a reason.
- **Latency** is roughly one analysis frame plus browser audio pipeline (tens of ms). Fine for sketching ideas, not for tight live performance next to a drummer.
- **Beatbox classification** is heuristic DSP, not ML. It works on clearly separated kick/snare/hat sounds and gets better when you train the pads. Ambiguous sounds are rejected rather than misfired.
- **Web MIDI** needs Chrome, Edge, or Firefox. Safari has never shipped it; on iPhone every browser is WebKit, so there is no MIDI out there. The built-in synth and MIDI file download cover those cases.

## Tests

`node tests/test-dsp.js` — 29 checks, all passing in this environment:

- YIN on synthesized sines (110–1174 Hz, plus a harmonic whistle stack): exact MIDI note every time, cents accurate, noise and silence correctly rejected.
- Note tracker: on/change/off sequencing, single-frame wobble does not retrigger.
- Drum classifier: kick/snare/hat reference hits classified correctly, silence rejected, onset detector fires exactly once per hit.
- MIDI writer: valid `MThd`/`MTrk` structure, note bytes, drum channel 9 encoding.

What node cannot test (no mic, no audio hardware in CI): real-microphone latency and feel, the permission UX in a real browser, and how the drum templates match a specific human mouth. Those need ears.
