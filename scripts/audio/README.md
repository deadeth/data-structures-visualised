# Recorded narration for design tours

Design pages can read each tour step aloud. The reader turns it on with the Audio button in the tour controls (off by default, remembered as `dsv.audio` in `localStorage`). With it on, entering a step plays that step's clip, and while the tour plays a step moves on only when both its usual wait and its clip have ended, then 400 ms. The player is `src/ui/design-audio.ts`.

## What is spoken

`narrationOf(step, n)` in `src/designs/narration.ts`: "Step n. Title.", the step's text, then its story's context (skipped when it opens as the text does), problem, consequence and fix. Not the "Step n explained" questions.

The words are rewritten for the voice by `spoken()` in the same file: symbols, clock times, addresses and paths, identifiers such as `crawler-07`, hex fingerprints, snake_case names and a pronunciation list ("RocksDB" to "Rocks D B", "WARC" to "wark", and so on). The rules were checked against the phonemes the voice's engine produces (`PiperVoice.phonemize` in Python), not by ear. `src/designs/narration.test.ts` has before and after examples. When you add a design, print its spoken text and read it for anything odd before recording:

```
node scripts/audio/render.mjs <design id> --print
```

## Recording

```
node scripts/audio/render.mjs <design id> [<design id> ...] [--force] [--print]
```

For the main tour and each story it writes `public/audio/<design>/<main|story id>/<n>.mp3` (n from 1) and regenerates `src/designs/narration-manifest.ts`, which holds, for each step, `hashOf(narrationOf(step, n))`: an FNV-1a hash of the written words (not the spoken rewrite). The page computes the same hash from its own data and plays a clip only when they match, so a clip goes silent, never wrong, the moment a step's words change. `npm test` lists stale steps without failing. A clip whose hash is unchanged is skipped; `--force` records every clip again (do that after changing `spoken()`, which the hash does not cover).

It refuses any design listed in `src/locked/manifest.ts`: those pages ship only encrypted, and files under `public/` are served to anyone. The narration test also fails if a locked id appears in the manifest or under `public/audio`.

Needs, on the machine that records (none of it is in the repo or the deploy workflow; the clips are committed):

- Python 3 with Piper (`pip install piper-tts`); `python3 -m piper -m <model> -f out.wav --sentence-silence 0.3` reads text on stdin. Set `PIPER_PYTHON` for another interpreter.
- A Piper voice: env `PIPER_VOICE`, default `/tmp/voices/en_GB-cori-high.onnx`, with its `.onnx.json` beside it.
- ffmpeg (env `FFMPEG`) with libmp3lame, and ffprobe for the durations it prints.

Each clip is mono MP3 at 22.05 kHz, 40 kbit/s, loudness-normalised (`loudnorm=I=-16:TP=-1.5`), with 0.3 s of silence at the end. About 5 KB a second: a 100-second step is about 0.5 MB.

## The voice

`en_GB-cori-high` from the Piper voices collection (rhasspy/piper-voices): a British English female voice, high quality, 22.05 kHz. Its model card gives the training data as LibriVox recordings with a dataset licence of public domain. Recheck the card before swapping voices; a voice trained on non-public data may carry conditions on its output.

## Known limits

- The voice cannot be checked by ear on the machine that built this; pronunciations were checked as phonemes. Listen to a few clips after recording a new design.
- Clips are long (a crawler step with its story is 60 to 110 seconds). The tour waits for them; a reader can press Next at any time.
- Clips for steps or stories that no longer exist are left on disk; the manifest stops naming them. Delete them by hand.
