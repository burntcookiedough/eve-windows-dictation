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
