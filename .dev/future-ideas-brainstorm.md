# Future Ideas Brainstorm

Raw list of potential features to explore.

---

## Ideas from Competitive Research

**1. Custom Vocabulary / Prompt Boosting**
Whisper supports an `initial_prompt` that can bias it toward specific terminology. You could let users define domain-specific words (medical terms, company names, technical jargon) that get boosted during transcription.

**2. Filler Word Removal**
Descript does this well - automatically strip "um", "uh", "like", "you know" from the final output. Could be a toggle. Simple post-processing but very useful.

**3. Translation Mode**
Whisper natively supports speech-to-English translation. You already have the infrastructure - just a flag to switch from transcription to translation. Speak in German, get English text.

**4. PII Redaction**
AssemblyAI and Amazon Transcribe offer this. Automatically detect and mask names, phone numbers, addresses, etc. Useful for sensitive recordings.

**5. Confidence-Based Highlighting**
You already return confidence scores. The UI could highlight low-confidence words in a different color, letting users know which parts might need review.

**6. Speaker Diarization**
Multiple speakers get labeled as "Speaker 1", "Speaker 2". faster-whisper might support this or you could add pyannote for it. Useful for meeting transcription.

---

## Ideas Based on Your Architecture

**7. Audio Recording / Playback**
Save the audio buffer to disk alongside transcription. Users could replay sections to verify accuracy. The buffer already exists - just write it out.

**8. Session History**
Keep a local SQLite or JSON log of past transcriptions with timestamps. Quick retrieval of "what did I dictate yesterday?"

**9. Hotkey Customization**
F17 is... unusual. Let users pick their own hotkey in settings.

**10. Audio Device Selection**
The test UI uses the default mic. Add a dropdown to select input device.

**11. "Correction Mode"**
If the user immediately starts a new recording right after a transcription, assume they're correcting the previous one. Could auto-replace the last paste.

**12. Streaming to Multiple Destinations**
Instead of just clipboard/paste, allow configuring destinations: append to a specific file, send to an API, insert into a specific app, etc.

---

## More Experimental Ideas

**13. Punctuation Enhancement**
Whisper's punctuation is decent but not perfect. A lightweight LLM pass (or even rule-based) could improve sentence boundaries, capitalization, paragraph breaks.

**14. "Thinking Out Loud" vs "Dictation" Modes**
Different use cases need different processing. Dictation should be verbatim; "thinking out loud" mode could summarize or clean up rambling speech.

**15. Wake Word Activation**
Instead of PTT, optionally support "Hey Murmur" style activation. More complex but hands-free.

**16. Noise Gate / Pre-processing**
Detect and warn about poor audio conditions. Maybe auto-boost gain if volume is too low.

**17. Latency/Accuracy Tradeoff Slider**
Let users choose: faster partials with lower accuracy vs slower but more accurate. Adjusts model size or processing parameters.
