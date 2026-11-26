# Public corpus licenses and fixture recipe

- **LibriSpeech ASR corpus, test-clean and test-other.** Vassil Panayotov,
  Guoguo Chen, Daniel Povey and Sanjeev Khudanpur. SLR12 identifies both
  archives under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  The pinned EU mirror archives are byte-identical to the Torchaudio SHA-256
  pins for OpenSLR resources. [OpenSLR corpus and mirrors](https://www.openslr.org/12/).
  [Torchaudio archive checksums](https://github.com/pytorch/audio/blob/main/src/torchaudio/datasets/librispeech.py).
- **DEMAND, DKITCHEN 16 kHz, channel 01.** Joachim Thiemann, Nobutaka Ito and
  Emmanuel Vincent. The publisher licenses the recorded audio under
  [CC BY-SA 3.0 Unported](https://creativecommons.org/licenses/by-sa/3.0/).
  Prepare the noisy mixes and hold them in scratch under that license.
  [Zenodo record and archive](https://zenodo.org/records/1227121).
- **Common Voice English.** Omitted. The official CC0 release is distributed
  through Mozilla Data Collective with account-gated access.
  [Mozilla terms](https://commonvoice.mozilla.org/en/terms).
- **AMI.** Omitted in favor of a deterministic synthetic impulse response
  with no external room recording. The model adds a short low-pass filter and
  reflections at 7, 19, 37, 55, 82, 115, 151 and 210 ms, normalized to the
  original signal's RMS. It is a distant acoustic proxy, not a measured laptop
  microphone.

The clean OpenSLR signal is the close proxy. Quiet adds no noise. Moderate
mixes DEMAND kitchen audio at 12 dB relative to speech-active 20 ms windows.
A final uniform gain avoids clipping. All fixtures are 16 kHz mono signed
16-bit PCM. The source pins and every output WAV's SHA-256 are verified.
LibriSpeech speech-only outputs retain CC BY 4.0 attribution.

Quick selects ten utterances per split within the frozen 5–15 s range,
including 0.4 s of lead and tail guard each. Selection prefers more distinct
speakers and references containing both numeric and names/terms spans. The
predeclared proper-name and domain-term list is necessary because aligned
references are upper-case. Multiword numbers retain their published form.
The scorer counts contiguous exact normalized tokens at the aligned
reference position.

Long concatenates every ordered utterance of the longest test-clean reader
and cycles that chapter sequence to reach exactly 1,800 s. The public test
splits provide under nine minutes for even that reader. The fixture has
natural human speech throughout and repeatedly exposes the model to the same
material. Report the unique source duration beside the 30-minute runtime.
Chunk checks flag missing aligned utterances and full normalized utterances
in insertion spans of the alignment. Repeated source words and spelling
errors can hide some omissions or duplications. This is weaker evidence than
30 unique minute markers or word-time alignment against an unbroken chapter.

No original or derived audio is tracked in Git or uploaded as CI evidence.
