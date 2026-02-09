# Research: ML/DL Approaches for Dictation Command Recognition

> **Context**: Murmur uses faster-whisper for ASR. We want to convert spoken commands
> ("period", "comma", "new line", "Punkt", "Komma") into actual punctuation/formatting.
> This research evaluates ML-based approaches beyond simple regex replacement.
>
> **Languages**: English + German
>
> **Date**: 2026-02-08

---

## TL;DR

**No purpose-built model exists** for dictation command disambiguation (is "period" a
command or a word?). The closest ML approaches are **punctuation restoration models**
that predict where punctuation belongs in unpunctuated text. These can serve as a
"second opinion" alongside rule-based command handling.

**Recommended stack for Murmur:**

1. Whisper already outputs punctuation — leverage this as primary signal
2. Rule-based command handler (Tier 1/2 from prior research) for explicit commands
3. Optional: small punctuation restoration model as disambiguation aid

The best small model candidate is **1-800-BAD-CODE/punct_cap_seg_47_language** (~100-200MB,
ONNX-native, 47 languages including EN+DE). The smallest option is **sherpa-onnx's
CNN-BiLSTM model** at just 7MB but it's English-only.

---

## Table of Contents

1. [Key Insight: Whisper Already Punctuates](#1-key-insight-whisper-already-punctuates)
2. [Punctuation Restoration Models](#2-punctuation-restoration-models)
3. [Inverse Text Normalization (ITN)](#3-inverse-text-normalization-itn)
4. [Small LLMs for This Task](#4-small-llms-for-this-task)
5. [How Existing Tools Handle This](#5-how-existing-tools-handle-this)
6. [German Language Considerations](#6-german-language-considerations)
7. [Architecture Options for Murmur](#7-architecture-options-for-murmur)
8. [Model Comparison Table](#8-model-comparison-table)
9. [Recommendation](#9-recommendation)
10. [Sources](#10-sources)

---

## 1. Key Insight: Whisper Already Punctuates

**This is the most important finding.** Whisper (and faster-whisper) already outputs
punctuated, capitalized text. Unlike CTC-based ASR models (Vosk, DeepSpeech) that
output raw lowercase text, Whisper's attention-based architecture naturally produces:

- Periods, commas, question marks, exclamation marks
- Proper capitalization
- Basic sentence structure

This means **punctuation restoration models are largely redundant** when using Whisper.
The primary remaining use case is:

- **Explicit dictation commands**: User says "new line" or "new paragraph" and expects
  formatting (Whisper won't convert these)
- **Overriding Whisper's choices**: User says "comma" because they want a comma where
  Whisper might not place one
- **German commands**: "Punkt", "Komma", "Fragezeichen", "neuer Absatz"

**Implication**: The problem is narrower than initially scoped. We don't need a model
to add punctuation — we need logic to detect when the user is issuing a formatting
command vs. speaking naturally.

---

## 2. Punctuation Restoration Models

These models take unpunctuated text and predict where punctuation belongs. While not
directly solving dictation command disambiguation, they could serve as a secondary
signal (if the model predicts a period at the same position where "period" appears,
that supports the command interpretation).

### 2.1 Best Candidates (EN + DE support)

#### 1-800-BAD-CODE/punct_cap_seg_47_language (Recommended)

| Property | Value |
|----------|-------|
| Architecture | Custom 6-layer Transformer (512-dim), SentencePiece 64k vocab |
| Parameters | ~30-60M estimated |
| Size on disk | ~100-200 MB (ONNX) |
| Languages | 47 languages (EN + DE included) |
| Labels | `.` `,` `?` + language-specific marks |
| ONNX | Yes — **native ONNX distribution** |
| Inference | Designed for speed; small architecture |
| Features | Punctuation + capitalization + sentence segmentation in one pass |
| Package | `pip install punctuators` |
| Link | [HuggingFace](https://huggingface.co/1-800-BAD-CODE/punct_cap_seg_47_language) / [GitHub](https://github.com/1-800-BAD-CODE/punctuators) |

English F1: Period 88%, Comma 68%, Question mark 78%.

```python
from punctuators.models import PunctCapSegModelONNX
m = PunctCapSegModelONNX.from_pretrained("pcs_47lang")
results = m.infer(["hello how are you doing today"])
```

**Why this is the top pick**: Smallest model with EN+DE, ONNX-native (no PyTorch
runtime needed), does three tasks in one pass.

#### oliverguhr/fullstop-punctuation-multilingual-sonar-base

| Property | Value |
|----------|-------|
| Architecture | XLM-RoBERTa Base (token classification) |
| Parameters | ~300M |
| Size on disk | ~1.1 GB |
| Languages | EN, DE, FR, IT, NL |
| Labels | `.` `,` `?` `-` `:` `0` |
| ONNX | Convertible via Optimum |
| Package | `pip install deepmultilingualpunctuation` |
| Link | [HuggingFace](https://huggingface.co/oliverguhr/fullstop-punctuation-multilingual-sonar-base) |

EN F1: Period 92%, Comma 80%. DE F1: Period 95%, Comma 94%.

Higher quality than punct_cap_seg but 5-10x larger.

#### oliverguhr/fullstop-punctuation-multilang-large

| Property | Value |
|----------|-------|
| Architecture | XLM-RoBERTa Large |
| Parameters | ~600M |
| Size on disk | ~2.24 GB |
| Languages | EN, DE, FR, IT |
| ONNX | Available (also quantized variant by ldenoue) |
| Package | `pip install deepmultilingualpunctuation` |
| Link | [HuggingFace](https://huggingface.co/oliverguhr/fullstop-punctuation-multilang-large) |

Best F1 scores (EN period: 95%, DE period: 96%) but very large.

### 2.2 Lightweight / Edge Models

#### sherpa-onnx CNN-BiLSTM (English only)

| Property | Value |
|----------|-------|
| Architecture | CNN-BiLSTM |
| Size | **7.1 MB** (int8) / 28 MB (fp32) |
| Languages | English only |
| Inference | ~13-30ms |
| ONNX | Yes (native) |
| Link | [sherpa-onnx models](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html) |

Incredibly small. Based on [Edge-Punct-Casing](https://github.com/frankyoujian/Edge-Punct-Casing).
**No German support** — would need to train a German variant.

#### Silero Text Enhancement

| Property | Value |
|----------|-------|
| Architecture | Proprietary (PyTorch JIT) |
| Size | Small (sub-100M estimated) |
| Languages | EN, DE, RU, ES |
| ONNX | No (JIT only) |
| Link | [GitHub](https://github.com/snakers4/silero-models) |

Supports German but closed architecture and no ONNX export.

### 2.3 Other Notable Models

| Model | Size | Languages | Notes |
|-------|------|-----------|-------|
| felflare/bert-restore-punctuation | 436 MB | EN only | 91% accuracy, Yelp-trained |
| NVIDIA NeMo punct_en_bert | 386 MB | EN only | 77% F1, NeMo ecosystem |
| NVIDIA NeMo punct_en_distilbert | 234 MB | EN only | Lighter NeMo option |
| recasepunc (Vosk) | 1.1-1.6 GB | EN, DE (separate) | BERT-based, large |

---

## 3. Inverse Text Normalization (ITN)

ITN converts spoken forms to written forms: "one hundred dollars" → "$100",
"may third" → "May 3". This is **adjacent to but different from** dictation commands.

### NVIDIA NeMo Text Processing

| Property | Value |
|----------|-------|
| Type | Rule-based (WFST grammars via Pynini) |
| Languages | EN, DE, ES, RU, and more |
| Install | `pip install nemo_text_processing` |
| Platform | **Linux x86_64 only** (Pynini dependency) |
| Link | [GitHub](https://github.com/NVIDIA/NeMo-text-processing) |

Handles numbers, dates, currencies, measures — but **NOT dictation commands**.
The WFST framework could theoretically be extended with custom grammars for
dictation commands, but this is heavy engineering.

### NVIDIA Thutmose Tagger (Neural ITN)

| Property | Value |
|----------|-------|
| Architecture | BERT-base + classification heads |
| Parameters | ~110M |
| Languages | EN, RU |
| Link | [NGC](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/itn_en_thutmose_bert) |

Neural alternative to WFST-based ITN. English/Russian only, no German.

### Verdict on ITN

ITN tools solve a different problem (number/date normalization, not dictation commands).
They don't handle "period" → "." or "new line" → "\n". Could be useful as an
additional pipeline stage for converting "twenty three dollars" → "$23" but that's
a separate feature.

---

## 4. Small LLMs for This Task

### Could a tiny LLM handle dictation commands?

In theory, yes. A model like SmolLM-135M, TinyLlama-1.1B, or Phi-3-mini could be
prompted to parse dictation commands. Example prompt:

```
Convert dictation commands to formatting. Only replace words that are clearly
formatting commands, not regular speech.

Input: "The Victorian period was fascinating period"
Output: "The Victorian period was fascinating."
```

### Practical problems

1. **Latency**: Even quantized, LLMs add 100-500ms+ per inference. This matters for
   real-time transcription where the text needs to appear immediately.

2. **Reliability**: Small LLMs are inconsistent at instruction-following. They might
   sometimes replace words that shouldn't be replaced, or miss commands.

3. **Resource usage**: faster-whisper already uses significant GPU/CPU. Adding an LLM
   doubles the compute requirements.

4. **Overkill**: The task is essentially a binary classification per token ("is this
   word a command or not?"). A full autoregressive LLM is architecturally wrong for
   this — a token classifier (BERT-style) is far more appropriate.

### Smallest viable LLMs

| Model | Parameters | Quantized Size | Latency (CPU) | Quality |
|-------|-----------|---------------|---------------|---------|
| SmolLM-135M | 135M | ~70MB (Q4) | ~50-100ms | Poor instruction following |
| SmolLM-360M | 360M | ~200MB (Q4) | ~100-200ms | Marginal |
| Qwen2.5-0.5B | 500M | ~300MB (Q4) | ~200-400ms | Usable for simple tasks |
| Phi-3-mini-4k | 3.8B | ~2GB (Q4) | ~1-3s | Good but too slow |

**Verdict**: Small LLMs are not the right tool for this task. A token classifier
(BERT-family) at 30-60M parameters will be faster, more reliable, and smaller than
even the tiniest LLM.

---

## 5. How Existing Tools Handle This

### Talon Voice

- Uses a **grammar-based command parser** with a custom DSL (`.talon` files)
- Separates **command mode** and **dictation mode** — the user explicitly switches
- In dictation mode, formatting commands are handled by custom Talon scripts
  (rule-based, not ML)
- Key insight: **modal separation** (command vs. dictation) eliminates most
  disambiguation. Murmur's push-to-talk is similar.

### Dragon NaturallySpeaking

- Proprietary, closed-source
- Uses a combination of **acoustic models** and **language models** trained
  specifically on command vocabularies
- Has separate acoustic signatures for command-mode speech (typically spoken more
  deliberately/slowly)
- Not reproducible in open-source

### Apple/Google/Windows Dictation

- All major OS dictation engines handle basic formatting commands
- Use large cloud-based models with dictation-specific training data
- Apple dictation (on-device mode) likely uses a dedicated command classifier
- Google's on-device model handles "period", "comma", "question mark", "exclamation
  point", "new line", "new paragraph" natively in the ASR output
- **Key insight**: These are all trained on massive datasets that include dictation
  command examples. No small open-source equivalent exists.

### nerd-dictation

- Pure regex/string replacement, no ML
- Maintains a `PUNCTUATION_MAP` similar to Tier 1
- [GitHub](https://github.com/ideasman42/nerd-dictation)

### OmniDictate

- Also pure string replacement after faster-whisper
- [GitHub](https://github.com/gurjar1/OmniDictate)

### Common pattern across all tools

Every open-source tool uses **rule-based replacement**. ML-based dictation command
handling only exists in commercial products (Dragon, Apple, Google) where it's
baked into the ASR model itself, not as a post-processing step.

---

## 6. German Language Considerations

### German dictation commands

| Spoken | Output | Notes |
|--------|--------|-------|
| "Punkt" | `.` | Also means "point/dot" in general |
| "Komma" | `,` | Less ambiguous than English "comma" |
| "Fragezeichen" | `?` | Unambiguous (literally "question mark") |
| "Ausrufezeichen" | `!` | Unambiguous (literally "exclamation mark") |
| "Doppelpunkt" | `:` | Unambiguous (literally "double point") |
| "Semikolon" | `;` | Unambiguous |
| "Anführungszeichen" | `"` | Literally "quotation mark" |
| "neue Zeile" | `\n` | Literally "new line" |
| "neuer Absatz" | `\n\n` | Literally "new paragraph" |
| "Leerzeichen" | ` ` | Literally "space character" |

**Good news**: German dictation commands are generally **less ambiguous** than English.
"Fragezeichen", "Ausrufezeichen", "Doppelpunkt" are compound words that rarely appear
in normal speech as anything other than commands. The main ambiguous one is "Punkt",
which can mean "point" (as in "talking point") or "period" (the punctuation).

### Models with German support

| Model | German Quality | Notes |
|-------|---------------|-------|
| punct_cap_seg_47_language | Good (part of 47-lang training) | Lower per-language quality due to multilingual tradeoff |
| fullstop-multilingual-sonar-base | Very good (DE comma F1: 94%) | Strong German-specific performance |
| fullstop-multilang-large | Best (DE period F1: 96%) | Highest quality but largest model |
| Silero TE | Good (dedicated DE support) | But no ONNX |
| recasepunc (Vosk DE) | Good | But 1.1 GB model |
| sherpa-onnx CNN-BiLSTM | None | English only |

---

## 7. Architecture Options for Murmur

### Option A: Rule-Based Only (Recommended Starting Point)

```
faster-whisper → regex command handler → output
                       ↓
              (period/comma/neue Zeile → ./,/\n)
```

- **Tier 1**: Simple string replacement for unambiguous commands
  ("new line", "new paragraph", "Fragezeichen", "Ausrufezeichen", etc.)
- **Tier 2**: Positional heuristics for ambiguous commands
  ("period" only at clause end, "Punkt" only at clause end)
- **Latency**: ~0ms
- **Complexity**: Low
- **Reliability**: High for common cases, known failure modes

Since Whisper already punctuates, explicit dictation commands serve as **overrides**
rather than primary punctuation. Most users won't say "period" because Whisper will
already add one.

### Option B: Rule-Based + Punctuation Model as Disambiguation Aid

```
faster-whisper → regex command handler
                       ↓
              ambiguous? ──no──→ apply command
                  │
                 yes
                  ↓
         punctuation model (ONNX) ──→ does model agree? ──→ apply or keep
```

When the rule-based handler encounters an ambiguous case (e.g., "period" mid-sentence),
consult a punctuation restoration model:

1. Strip the word "period" from the text
2. Run through punctuation model
3. If model predicts a period at that position → treat as command
4. If model doesn't predict a period → keep as literal word

**Best model for this**: `punct_cap_seg_47_language` (small, ONNX, EN+DE)

- **Latency**: ~20-50ms for ambiguous cases only
- **Complexity**: Moderate
- **Reliability**: Better disambiguation for edge cases

### Option C: Custom Token Classifier (Fine-tuned)

Train a small BERT/DistilBERT to classify each token as `COMMAND` or `WORD`:

```
Input:  "the victorian period was fascinating period"
Labels:  WORD  WORD      WORD    WORD  WORD        COMMAND
```

- Would need labeled training data (doesn't exist — would need to create)
- ~66-110M parameters (DistilBERT/BERT-base)
- Very accurate once trained, but significant upfront effort
- **Not recommended** unless Murmur scales to thousands of users

### Option D: Fine-tune Whisper Itself

Add dictation commands to Whisper's vocabulary during fine-tuning:

- Train on data where "period" at clause boundaries is transcribed as "."
- Whisper would output punctuation directly without post-processing
- Requires significant fine-tuning infrastructure and data
- Would lose model generality
- **Not recommended** for Murmur's scope

---

## 8. Model Comparison Table

| Model | Size | ONNX | EN+DE | Latency | Use Case |
|-------|------|------|-------|---------|----------|
| **punct_cap_seg_47_language** | ~100-200MB | Yes (native) | Yes | ~20-50ms | Best small multilingual option |
| fullstop-sonar-base | ~1.1GB | Convertible | Yes | ~50-100ms | Better quality, larger |
| fullstop-multilang-large | ~2.2GB | Yes | Yes | ~100-200ms | Best quality, very large |
| sherpa-onnx CNN-BiLSTM | **7MB** | Yes | EN only | ~13-30ms | Smallest, but no German |
| Silero TE | ~50-100MB? | No | Yes | Unknown | Good but closed |
| SmolLM-135M (LLM) | ~70MB Q4 | Yes | Yes | ~50-100ms | Wrong architecture for this task |
| Regex rules | 0 | N/A | Yes | ~0ms | Simplest, proven |

---

## 9. Recommendation

### Phase 1: Ship with rules (Tier 1 + Tier 2)

Implement in `app/src/main/services/pipeline.ts` → `applyPostProcessing()`:

1. **Multi-word commands first** (unambiguous): "new line", "new paragraph",
   "question mark", "exclamation point", "neue Zeile", "neuer Absatz",
   "Fragezeichen", "Ausrufezeichen", "Doppelpunkt"
2. **Single-word commands with heuristics**: "period"/"Punkt" only at clause end,
   "comma"/"Komma" after 1+ words
3. **User-configurable command map** in settings (power users can customize)

This handles 90%+ of cases with zero dependencies.

### Phase 2: Optional ML disambiguation (if needed)

If users report false positives (e.g., "the Victorian period" getting punctuated),
add `punct_cap_seg_47_language` as a server-side ONNX model:

- Load once at server startup alongside faster-whisper
- Only invoke when ambiguity is detected by the rule engine
- Use the model's prediction as a tiebreaker
- Add as a Python dependency: `pip install punctuators`

### What NOT to do

- **Don't use an LLM** for this — wrong architecture, too slow, unreliable
- **Don't fine-tune Whisper** — massive effort for marginal gain
- **Don't build a custom classifier** — no training data, overkill for the problem
- **Don't add punctuation restoration on top of Whisper** — Whisper already punctuates,
  adding another model would create conflicts

---

## 10. Sources

### Models

- [1-800-BAD-CODE/punct_cap_seg_47_language](https://huggingface.co/1-800-BAD-CODE/punct_cap_seg_47_language)
- [punctuators library](https://github.com/1-800-BAD-CODE/punctuators)
- [oliverguhr/fullstop-punctuation-multilang-large](https://huggingface.co/oliverguhr/fullstop-punctuation-multilang-large)
- [oliverguhr/fullstop-punctuation-multilingual-sonar-base](https://huggingface.co/oliverguhr/fullstop-punctuation-multilingual-sonar-base)
- [deepmultilingualpunctuation (PyPI)](https://pypi.org/project/deepmultilingualpunctuation/)
- [ldenoue ONNX quantized variant](https://huggingface.co/ldenoue/fullstop-punctuation-multilang-large)
- [felflare/bert-restore-punctuation](https://huggingface.co/felflare/bert-restore-punctuation)
- [sherpa-onnx punctuation models](https://k2-fsa.github.io/sherpa/onnx/punctuation/pretrained_models.html)
- [Edge-Punct-Casing](https://github.com/frankyoujian/Edge-Punct-Casing)
- [Silero Models](https://github.com/snakers4/silero-models)
- [recasepunc](https://github.com/benob/recasepunc)
- [Vosk Models](https://alphacephei.com/vosk/models)

### ITN / Text Normalization

- [NVIDIA NeMo Text Processing](https://github.com/NVIDIA/NeMo-text-processing)
- [NeMo ITN Documentation](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/nlp/text_normalization/intro.html)
- [Thutmose Tagger (NGC)](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/itn_en_thutmose_bert)
- [WeTextProcessing](https://github.com/wenet-e2e/WeTextProcessing)
- [Google Sparrowhawk](https://github.com/google/sparrowhawk)

### Voice Dictation Tools

- [Talon Voice](https://talonvoice.com/)
- [nerd-dictation](https://github.com/ideasman42/nerd-dictation)
- [OmniDictate](https://github.com/gurjar1/OmniDictate)
- [Picovoice Rhino](https://picovoice.ai/platform/rhino/)

### NeMo Punctuation

- [NeMo punctuation_en_bert (NGC)](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/punctuation_en_bert)
- [NeMo punctuation_en_distilbert (NGC)](https://catalog.ngc.nvidia.com/orgs/nvidia/teams/nemo/models/punctuation_en_distilbert)

### Other

- [ai4bharat/Cadence (Mark My Words)](https://huggingface.co/ai4bharat/Cadence)
- [Cadence paper (arXiv)](https://arxiv.org/abs/2506.03793)
