# VOXMIDI

Voice to MIDI in the browser. Hum, sing or whistle for notes. Beatbox for drums. Output goes to a MIDI device, the built-in synth, or a downloadable `.mid` file.

## Run

No build step and no dependencies. The microphone needs `https` or `localhost`.

```sh
npm run serve        # or: python3 -m http.server 8080
# open http://localhost:8080
```

## Screens

- **Play.** Beatbox pads on the left, pitch wheel on the right, playable keyboard below. The lit wheel sector is the note sounding. The needle and trail show where your voice is, so bends and slides are visible. The inner arc is input loudness, which sets velocity. Amber labels and keyboard dots mark the key and scale. Key, scale, octave and gate sit beside the wheel. Find key reads a sung phrase and sets key and scale.
- **Train.** Record up to 12 takes per pad. Each hit becomes a take; a hit fires the pad whose take is closest. The map shows where each take sits on the brightness axis.
- **Setup.** Microphone, MIDI output, Stay in key, pitch bend, velocity, beatbox on or off.

Keyboard and pads respond to where you press: lower is harder.

## Code

| File | Role |
| --- | --- |
| `js/pitch.js` | YIN pitch detection and the debounced note tracker |
| `js/drums.js` | Onset gate, spectral features, nearest-take classifier |
| `js/engine.js` | Mic graph, 80 Hz analysis loop, Web MIDI, built-in synth, session recorder |
| `js/midifile.js` | Session events to a Standard MIDI File |
| `js/key.js` | Key detection from a pitch-class histogram |
| `js/pads.js` | Trained take storage and classifier templates |
| `js/wheel.js`, `js/keyboard.js`, `js/train.js` | Canvas wheel, keyboard, Train tab |
| `js/ui.js` | Wizard, tabs, wiring |

## Tests

`npm test` runs 61 checks: pitch accuracy, note tracking, drum classification, onset gating, SMF bytes, octave routing, trained takes, key detection. `npm run eval` runs the adversarial pitch evaluation.

Not covered, because it needs a microphone and ears: real-mic latency, how the drum features match a particular mouth, and how the screens look at your window size.

## Limits

- One note at a time. No chords.
- Analysis runs on `requestAnimationFrame`, so a minimized or fully covered browser window stops listening. Keep the window visible next to your DAW.
- Latency is one analysis frame plus the browser audio path.
- Beatbox classification is spectral heuristics, not a trained model. Train the pads for your own sounds.
- Web MIDI works in Chrome, Edge and Firefox. Safari has no MIDI output.
- Pitch bend range is plus or minus 2 semitones.
