# Future Ideas

Research and experimentation ideas for potential implementation.

---

## Smarter Partial Transcription via Pause Detection

**Status:** Idea / To Research

**Problem:**
Currently, partial (live) transcription sends the entire accumulated audio buffer for each update. This becomes increasingly inefficient as the recording grows longer.

**Proposed Approach:**
Detect significant pauses in the audio stream that likely indicate context breaks (sentence boundaries, thought breaks, etc.). When a pause is detected:

1. Only send the audio *after* the detected pause for partial transcription
2. Keep track of the "committed" text from before the pause
3. Merge the new partial with the previously committed text for display

**Key Considerations:**
- **Final transcription unchanged:** The final transcription would still process the complete audio buffer to ensure accuracy and proper context
- **Complexity:** Merging partials becomes more complex - need to track what's "committed" vs "in-flight"
- **Pause detection:** Need to determine appropriate silence threshold and duration to detect meaningful breaks without being too aggressive
- **Edge cases:** What happens if the speaker corrects something from before the pause? The partial would miss it, but final would catch it

**Potential Benefits:**
- Reduced API costs for partial transcriptions
- Faster partial responses (less audio to process)
- Lower latency for live text updates

**Questions to Research:**
- What's the optimal silence duration to detect a "meaningful" pause?
- How do transcription APIs handle very short audio clips?
- Is there existing literature on VAD (Voice Activity Detection) for this use case?

---

## Voice Commands

**Status:** Idea

**Concept:**
Use the transcription pipeline to detect and execute voice commands instead of (or in addition to) transcribing speech as text. The system would recognize specific phrases as commands and perform actions rather than pasting the transcribed text.

**Example Commands:**
- "Delete last transcription" - Remove the most recent entry from history
- "Delete last 3 entries" - Remove the N most recent history entries
- "Undo" - Revert the last paste action
- "Cancel" - Abort the current transcription without pasting

**Implementation Considerations:**
- **Detection:** How to distinguish commands from regular dictation? Options:
  - Dedicated hotkey for "command mode" vs "dictation mode"
  - Keyword prefix (e.g., "Murmur, delete last entry")
  - Pattern matching on transcribed text (risky - false positives)
- **Execution:** Commands need access to app state (history, clipboard, etc.)
- **Feedback:** User needs confirmation that a command was recognized and executed
- **Extensibility:** Design command system to easily add new commands later

**Potential Commands to Explore:**
- History management (delete, search, copy previous)
- Settings toggles ("enable/disable filler word removal")
- Transcription control ("read that back", "start over")
- Clipboard operations ("copy last 3 transcriptions")

---

## Custom Word List for Improved Recognition

**Status:** Idea

**Research notes:** See `.dev/research-custom-word-list.md`

**Problem:**
Speech recognition models sometimes consistently misrecognize certain words, especially domain-specific terms, technical jargon, names, or uncommon words. Users may notice the same word getting transcribed incorrectly over and over, with no way to correct the model's behavior.

**Concept:**
Allow users to maintain a custom word list that hints the transcription model toward specific spellings or terms. This isn't meant for high-frequency words used in every sentence, but rather for occasional terms that the model struggles with - words you notice repeatedly getting wrong.

**Example Use Cases:**
- Technical terms: "Kubernetes" always transcribed as "Cooper Netties"
- Product names: "Svelte" transcribed as "svelt" or "felt"
- Personal names: "Raikr" transcribed as "Raker" or "Ryker"
- Acronyms: "IPC" transcribed as "I PC" or "IP see"
- Domain jargon: Industry-specific terminology

**Implementation Considerations:**
- **UI:** Simple list management in settings - add, edit, remove words
- **Whisper support:** Investigate `initial_prompt` parameter in faster-whisper which can bias the model toward certain vocabulary
- **Format:** Should entries be just words, or word + common misrecognitions?
- **Sync:** Store in settings so it persists and potentially syncs
- **Scope:** Global list vs per-context lists (e.g., "coding mode" vs "medical mode")

**Technical Research Needed:**
- How effective is Whisper's `initial_prompt` for vocabulary biasing?
- Are there other approaches (fine-tuning, post-processing corrections)?
- What's the limit on how many words can be biased effectively?
- Should misrecognized → correct mappings be used as post-processing replacements?

**Potential Enhancements:**
- Auto-suggest words to add based on frequent manual corrections in history
- Import/export word lists for sharing
- Categorized word lists (enable/disable groups based on context)
