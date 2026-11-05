# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["kokoro-onnx==0.5.0", "soundfile", "numpy"]
# ///
"""Turns a demo-capture take into the narrated submission video.

Speaks each scene of docs/runbooks/voiceover.md with Kokoro (free, runs locally), then fits each
scene of the footage to its narration: long scenes such as the agent wait are sped up, short ones
are slowed a little and then hold their last frame.

    uv run scripts/demo-narrate.py demo-capture/<timestamp>

Writes narrated.mp4 and the scene clips to that folder. The first run downloads the voice model
(about 340 MB) to demo-capture/tts/.
"""
import argparse
import json
import re
import subprocess
import urllib.request
from pathlib import Path

import numpy as np
import soundfile
from kokoro_onnx import Kokoro

MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
MODEL_FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]
SAMPLE_RATE = 24_000
BREATH_SECONDS = 0.28
TAIL_SECONDS = 0.6
MAX_SLOWDOWN = 1.25
LIMIT_SECONDS = 180
# Respellings for words the voice would otherwise say wrongly.
SAY = {"Aurrery": "Orrery"}


def scenes_from_script(path: Path) -> dict[int, list[str]]:
    """Scene number to its spoken phrases: the quoted lines, split at each `/` breath mark."""
    scenes: dict[int, list[str]] = {}
    current = None
    for line in path.read_text(encoding="utf-8").splitlines():
        heading = re.match(r"## (\d+)\. ", line)
        if heading:
            current = int(heading.group(1))
        elif line.startswith("## "):
            current = None
        elif current and line.startswith("> "):
            text = line[2:].replace("**", "")
            for word, spoken in SAY.items():
                text = text.replace(word, spoken)
            scenes[current] = [part.strip() for part in text.split("/") if part.strip()]
    return scenes


def speak(tts: Kokoro, phrases: list[str], voice: str, speed: float) -> np.ndarray:
    breath = np.zeros(int(BREATH_SECONDS * SAMPLE_RATE), dtype=np.float32)
    parts = []
    for phrase in phrases:
        samples, rate = tts.create(phrase, voice=voice, speed=speed, lang="en-us")
        assert rate == SAMPLE_RATE
        parts += [samples, breath]
    return np.concatenate(parts + [np.zeros(int(TAIL_SECONDS * SAMPLE_RATE), dtype=np.float32)])


def video_duration(path: Path) -> float:
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], text=True))


def fit_filter(index: int, start: float, end: float, target: float) -> str:
    length = end - start
    factor = target / length if length > target else min(target / length, MAX_SLOWDOWN)
    hold = max(0.0, target - length * factor)
    steps = [f"trim=start={start:.3f}:end={end:.3f}", f"setpts=(PTS-STARTPTS)*{factor:.4f}"]
    if hold > 0:
        steps.append(f"tpad=stop_mode=clone:stop_duration={hold:.3f}")
    steps += ["fps=30", "scale=1920:1080:flags=lanczos", "format=yuv420p", f"trim=duration={target:.3f}", "setpts=PTS-STARTPTS"]
    return f"[0:v]{','.join(steps)}[v{index}]"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("take", type=Path, help="Folder written by npm run demo:capture")
    parser.add_argument("--voice", default="af_heart", help="Kokoro voice, for example af_heart, af_sarah, am_michael, bf_emma")
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    source = next(path for path in [args.take / "demo.mp4", args.take / "demo.webm"] if path.exists())
    marks = json.loads((args.take / "marks.json").read_text(encoding="utf-8"))
    scenes = scenes_from_script(Path("docs/runbooks/voiceover.md"))

    models = Path("demo-capture/tts")
    models.mkdir(parents=True, exist_ok=True)
    for name in MODEL_FILES:
        if not (models / name).exists():
            print(f"Downloading {name}…", flush=True)
            urllib.request.urlretrieve(MODEL_URL + name, models / name)
    tts = Kokoro(str(models / MODEL_FILES[0]), str(models / MODEL_FILES[1]))

    end_of_video = video_duration(source)
    audio, filters, labels, total = [], [], [], 0.0
    for i, mark in enumerate(marks):
        number = mark["scene"]
        clip = speak(tts, scenes[number], args.voice, args.speed)
        soundfile.write(args.take / f"voice-{number}.wav", clip, SAMPLE_RATE)
        audio.append(clip)
        start = mark["atSeconds"]
        end = marks[i + 1]["atSeconds"] if i + 1 < len(marks) else end_of_video
        target = len(clip) / SAMPLE_RATE
        filters.append(fit_filter(i, start, end, target))
        labels.append(f"[v{i}]")
        total += target
        print(f"Scene {number}: footage {end - start:5.1f}s, narration {target:5.1f}s")

    narration = args.take / "voice.wav"
    soundfile.write(narration, np.concatenate(audio), SAMPLE_RATE)
    filters.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[v]")
    output = args.take / "narrated.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-i", str(narration), "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "1:a",
                    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(output)], check=True)
    print(f"Saved {output} ({total:.0f}s)")
    if total >= LIMIT_SECONDS:
        print(f"Warning: over the {LIMIT_SECONDS}s limit. Cut a line from the script or raise --speed.")


if __name__ == "__main__":
    main()
