"""Build the public-corpus Eve fixtures in a scratch directory outside the checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tarfile
import wave
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import av
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.validation_harness import normalize_text

RATE = 16_000
LONG_SECONDS = 1_800
SNR_DB = 12
CONFIGS = ("close-quiet", "close-moderate", "far-quiet", "far-moderate", "gpu-close-quiet")
SOURCES = Path(__file__).with_name("sources.json")
NUMBERS = (r"zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
           r"fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|"
           r"sixty|seventy|eighty|ninety|hundred|thousand|million|first|second|third|fourth|"
           r"fifth|sixth|seventh|eighth|ninth|tenth")
# All-caps LibriSpeech alignments have no capitalization metadata. This fixed list
# marks unambiguous names and uncommon names of places and things in the selection.
NAMES_AND_TERMS = frozenset(["abraham", "achilles", "adam", "adelaide", "africa", "agnes", "albert", "alexander", "alfred", "alice", "america", "american", "andrew", "angela", "anna", "anne", "anthony", "arabia", "arthur", "asia", "athens", "australia", "austria", "barbara", "belgium", "berlin", "boston", "britain", "british", "caesar", "california", "canada", "caroline", "catharine", "catherine", "charles", "charlotte", "china", "christ", "christopher", "columbus", "constantinople", "daniel", "david", "denmark", "dick", "dickens", "edinburgh", "edward", "egypt", "elizabeth", "ellen", "emily", "england", "english", "esther", "europe", "france", "francis", "frank", "frederick", "french", "george", "germany", "gibraltar", "greece", "harold", "harry", "helen", "henry", "homer", "india", "ireland", "irish", "isaac", "isabel", "italy", "jacob", "james", "jane", "janet", "japan", "jerusalem", "jesus", "joan", "john", "joseph", "julia", "kate", "katherine", "kent", "laura", "lawrence", "lewis", "lincoln", "london", "louis", "louisa", "lucy", "margaret", "maria", "marie", "martha", "mary", "massachusetts", "matthew", "michael", "milan", "moses", "naples", "napoleon", "newton", "nicholas", "norway", "oliver", "oxford", "paris", "patrick", "paul", "philadelphia", "philip", "poland", "richard", "robert", "rome", "russia", "samuel", "sarah", "scotland", "shakespeare", "siberia", "sophia", "spain", "spanish", "stephen", "sweden", "switzerland", "thames", "thomas", "venice", "victoria", "virginia", "washington", "william", "york", "abbess", "alchemy", "amphitheatre", "archbishop", "archipelago", "artillery", "astrolabe", "battalion", "bishop", "cathedral", "chronicle", "citadel", "consulate", "covenant", "diplomat", "duchess", "embroidery", "envoy", "frigate", "garrison", "hemisphere", "herald", "hierarchy", "infantry", "magistrate", "monastery", "monument", "navigation", "parliament", "philosopher", "pilgrimage", "regiment", "republic", "sanctuary", "sovereign", "superintendent", "telescope", "theological", "viceroy"])


def digest(path, algorithm="sha256"):
    with path.open("rb") as source:
        return hashlib.file_digest(source, algorithm).hexdigest()


def source_file(root, pin):
    path = root / pin["filename"]
    if path.is_file() and digest(path) == pin["sha256"]:
        return path
    part = path.with_suffix(path.suffix + ".part")
    for _ in range(3):
        if part.is_file() and digest(part) == pin["sha256"]:
            break
        result = subprocess.run(
            ["curl.exe", "--disable", "--fail", "--silent", "--show-error", "--location",
             "--continue-at", "-", "--connect-timeout", "30", "--max-time", "700",
             "--write-out", "%{http_code}",
             "--output", str(part), pin["url"]],
            check=False, stdout=subprocess.PIPE, text=True,
        )
        if result.returncode == 0 and part.is_file():
            if digest(part) == pin["sha256"]:
                break
            part.unlink()
        elif result.returncode in {33, 36} or result.stdout.strip() == "416":
            # The server rejected the existing resume offset.
            part.unlink(missing_ok=True)
    if not part.is_file() or digest(part) != pin["sha256"]:
        raise ValueError(f"Download incomplete or SHA-256 mismatch for {path.name}")
    part.replace(path)
    return path


def speech_index(archive_path, split, root):
    """Extract only expected LibriSpeech media and alignment members."""
    utterances = {}
    references = {}
    allowed = re.compile(
        rf"LibriSpeech/{split}/(\d+)/(\d+)/(\d+-\d+-\d+\.flac|\d+-\d+\.trans\.txt)"
    )
    with tarfile.open(archive_path, "r|gz") as archive:
        for member in archive:
            match = allowed.fullmatch(member.name)
            if match is None or not member.isfile():
                continue
            reader, chapter, filename = match.groups()
            with archive.extractfile(member) as source:
                data = source.read()
            if filename.endswith(".flac"):
                utterance = filename.removesuffix(".flac")
                if not utterance.startswith(f"{reader}-{chapter}-") or utterance in utterances:
                    raise ValueError("Unexpected LibriSpeech utterance identity")
                if data[:4] != b"fLaC":
                    raise ValueError("Unexpected LibriSpeech encoding")
                sample_info = int.from_bytes(data[18:26], "big")
                if sample_info >> 44 != RATE or ((sample_info >> 41) & 7) != 0:
                    raise ValueError("Unexpected LibriSpeech sample rate or channels")
                audio = root / filename
                audio.write_bytes(data)
                utterances[utterance] = {
                    "source_id": utterance, "speaker": reader, "split": split,
                    "samples": sample_info & ((1 << 36) - 1), "audio": audio,
                }
            else:
                for line in data.decode("utf-8").splitlines():
                    key, text = line.split(" ", 1)
                    if key in references or not key.startswith(f"{reader}-{chapter}-"):
                        raise ValueError("Unexpected LibriSpeech transcript identity")
                    references[key] = text
    if not utterances or utterances.keys() != references.keys():
        raise ValueError("LibriSpeech audio and alignment indexes differ")
    for key, data in sorted(utterances.items()):
        reference = references[key]
        yield {**data, "reference": reference, "entities": entity_spans(reference)}


def entity_spans(reference):
    words = normalize_text(reference).split()
    spans = []
    index = 0
    while index < len(words):
        if re.fullmatch(NUMBERS, words[index]):
            end = index + 1
            while end < len(words) and (
                re.fullmatch(NUMBERS, words[end])
                or (words[end] == "and" and end + 1 < len(words)
                    and words[end - 1] in {"hundred", "thousand", "million"}
                    and re.fullmatch(NUMBERS, words[end + 1]))
            ):
                end += 1
            spans.append([index, end, "number"])
            index = end
            continue
        if words[index] in NAMES_AND_TERMS:
            spans.append([index, index + 1, "name-or-term"])
        index += 1
    return spans


def choose_quick(index, splits=("test-clean", "test-other"), per_split=10):
    selected = []
    for split in splits:
        used = Counter()
        candidates = [
            row for row in index if row["split"] == split
            and 5 * RATE <= row["samples"] <= int(14.2 * RATE)
            and row["entities"]
        ]
        # Prefer clips with both kinds of marked spans, then distinct speakers.
        for _ in range(per_split):
            picked = min(candidates, key=lambda row: (
                used[row["speaker"]], -len({e[2] for e in row["entities"]}),
                -len(row["entities"]), row["source_id"],
            ))
            candidates.remove(picked)
            used[picked["speaker"]] += 1
            selected.append(picked)
    return selected


def decode_audio(row):
    with av.open(str(row["audio"])) as container:
        frames = [
            frame.to_ndarray().reshape(-1) for frame in container.decode(audio=0)
        ]
    pcm = np.concatenate(frames)
    if pcm.dtype != np.int16 or pcm.size != row["samples"]:
        raise ValueError("Decoded FLAC disagrees with the pinned audio metadata")
    return pcm.astype(np.float32) / 32768


def long_audio(speech):
    readers = defaultdict(list)
    for row in speech:
        if row["split"] == "test-clean":
            readers[row["speaker"]].append(row)
    chapter_order = max(readers.values(), key=lambda rows: sum(row["samples"] for row in rows))
    total = LONG_SECONDS * RATE
    gap = int(0.10 * RATE)
    margin = int(0.40 * RATE)
    available = total - 2 * margin
    selected = []
    used = 0
    while True:
        row = chapter_order[len(selected) % len(chapter_order)]
        duration = row["samples"] + gap
        if used + duration > available:
            break
        selected.append(row)
        used += duration
    # Distribute the remainder as short pauses so time and reference stay exact.
    extra_gap, extra_samples = divmod(available - used, len(selected))
    pcm = np.zeros(total, dtype=np.float32)
    cursor = margin
    references = []
    entities = []
    word_offset = 0
    chunks = []
    for index, row in enumerate(selected):
        audio = decode_audio(row)
        pcm[cursor:cursor + len(audio)] = audio
        cursor += len(audio) + gap + extra_gap + (index < extra_samples)
        text = row["reference"]
        count = len(normalize_text(text).split())
        references.append(text)
        entities.extend([word_offset + start, word_offset + end, kind]
                        for start, end, kind in row["entities"])
        chunks.append([word_offset, word_offset + count])
        word_offset += count
    return pcm, {
        "reference": " ".join(references), "entities": entities, "chunks": chunks,
        "source_ids": [row["source_id"] for row in selected],
        "speaker": selected[0]["speaker"],
        "unique_source_seconds": sum(row["samples"] for row in chapter_order) / RATE,
    }


def demand_noise(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith("/ch01.wav")]
        if len(names) != 1:
            raise ValueError("DEMAND ch01.wav is missing or ambiguous")
        with archive.open(names[0]) as stream, wave.open(stream, "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, RATE):
                raise ValueError("Unexpected DEMAND format")
            data = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32)
    return (data - data.mean()) / 32768


def distant_mic(signal):
    # Original finite synthetic room response. The far proxy adds early and
    # late reflections plus mild high-frequency attenuation at equal RMS.
    lowpass = np.convolve(signal, np.array([.17, .66, .17], dtype=np.float32), mode="same")
    room = .62 * lowpass
    for milliseconds, gain in [(7, .21), (19, -.19), (37, .16), (55, .13),
                               (82, -.095), (115, .07), (151, -.043), (210, .025)]:
        offset = int(RATE * milliseconds / 1000)
        room[offset:] += gain * lowpass[:-offset]
    return room * np.sqrt(np.mean(signal**2) / np.mean(room**2))


def add_noise(signal, loop, seed):
    offset = seed * 31_337 % len(loop)
    repeat = np.tile(loop, (len(signal) + offset + len(loop) - 1) // len(loop))
    noise = repeat[offset:offset + len(signal)]
    usable = len(signal) // 320 * 320
    speech_windows = signal[:usable].reshape(-1, 320)
    energy = np.mean(speech_windows**2, axis=1)
    active = energy >= .01 * energy.max()
    noise_energy = np.mean(noise[:usable].reshape(-1, 320)[active] ** 2)
    gain = np.sqrt(energy[active].mean() / (noise_energy * 10 ** (SNR_DB / 10)))
    return signal + gain * noise


def write_wav(path, signal):
    peak = np.max(np.abs(signal))
    if peak > .98:
        signal = signal * (.98 / peak)
    frames = np.rint(np.clip(signal, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, RATE, 0, "NONE", ""))
        wav.writeframes(frames.tobytes())
    return digest(path)


def prepare(root, config=None, smoke=False):
    if root.is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError("Corpus cache must be outside the repository")
    root.mkdir(parents=True, exist_ok=True)
    pins = json.loads(SOURCES.read_text(encoding="utf-8"))
    audio_root = root / "public-flac"
    audio_root.mkdir(exist_ok=True)
    splits = ("test-clean",) if smoke else ("test-clean", "test-other")
    rows = [
        row for split in splits
        for row in speech_index(source_file(root, pins[split]), split, audio_root)
    ]
    configs = (config,) if config else CONFIGS
    noise = demand_noise(source_file(root, pins["noise"])) if any(
        name.endswith("-moderate") for name in configs
    ) else None
    quick = choose_quick(rows, splits, 1 if smoke else 10)
    manifest = []
    clips = [
        (f"Q{i:02}", np.pad(decode_audio(row), (6400, 6400)),
         {key: row[key] for key in ("reference", "entities", "speaker", "split", "source_id")})
        for i, row in enumerate(quick, 1)
    ]
    if not smoke:
        long_signal, long_ref = long_audio(rows)
        clips.append(("L01", long_signal, long_ref))
    for seed, (clip_id, close, metadata) in enumerate(clips, 1):
        far = distant_mic(close) if any(name.startswith("far-") for name in configs) else None
        for name in configs:
            signal = far if name.startswith("far-") else close
            if name.endswith("-moderate"):
                signal = add_noise(signal, noise, seed)
            path = root / f"{name}-{clip_id}.wav"
            manifest.append({
                "id": clip_id, "config": name, "mode": "long" if clip_id == "L01" else "quick",
                "path": path.name, "sha256": write_wav(path, signal),
                "duration_s": len(signal) / RATE, **metadata,
            })
    path = root / "manifest.json"
    path.write_text(json.dumps({"schema": 1, "clips": manifest}, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(manifest)} fixtures, manifest SHA-256 {digest(path)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--config", choices=CONFIGS)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    if args.smoke and args.config != "close-quiet":
        parser.error("--smoke requires --config close-quiet")
    prepare(args.root.resolve(), args.config, args.smoke)


if __name__ == "__main__":
    main()
