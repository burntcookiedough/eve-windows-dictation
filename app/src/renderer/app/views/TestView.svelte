<script lang="ts">
  interface PartialResult {
    type: 'partial' | 'final';
    text: string;
    processingTime: number;
  }

  // TODO: Wire up to actual recording state via IPC
  let isRecording = $state(false);

  // TODO: Wire up to actual transcription results via IPC
  let finalResult = $state('');
  let partialResults = $state<PartialResult[]>([]);

  function handleToggleRecording() {
    // TODO: Send IPC to start/stop recording
    isRecording = !isRecording;
    console.log(isRecording ? 'Start recording' : 'Stop recording');

    // Clear results when starting new recording
    if (isRecording) {
      finalResult = '';
      partialResults = [];
    }
  }

  function handleCopyResult() {
    if (finalResult) {
      // TODO: Use IPC to copy
      console.log('Copy result:', finalResult);
    }
  }
</script>

<div class="h-full p-6 pr-2">
  <div class="h-full overflow-y-auto pr-4">
    <div class="max-w-xl mx-auto">

    <!-- Record Button -->
    <div class="flex flex-col items-center py-12">
      <button
        onclick={handleToggleRecording}
        class="w-32 h-32 rounded-full flex items-center justify-center transition-all duration-300 cursor-pointer
          {isRecording
            ? 'bg-gradient-to-br from-red-500 to-red-600 shadow-2xl shadow-red-900/40 scale-110'
            : 'bg-gradient-to-br from-zinc-800 to-zinc-900 hover:from-zinc-700 hover:to-zinc-800 hover:scale-105'
          }"
      >
        {#if isRecording}
          <!-- Stop icon -->
          <div class="w-10 h-10 bg-white rounded-md"></div>
        {:else}
          <!-- Microphone icon -->
          <svg class="w-14 h-14 text-zinc-400" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        {/if}
      </button>
      <p class="text-sm text-zinc-500 mt-6">
        {isRecording ? 'Recording... Click to stop' : 'Click to start recording'}
      </p>
    </div>

    <!-- Results Section -->
    <div class="space-y-6">

      <!-- Final Result -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Final Result
          </h3>
          {#if finalResult}
            <button
              onclick={handleCopyResult}
              class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              Copy
            </button>
          {/if}
        </div>
        <div class="p-4 bg-zinc-900/50 rounded-xl min-h-[100px]">
          {#if finalResult}
            <p class="text-sm text-zinc-200">{finalResult}</p>
          {:else}
            <p class="text-sm text-zinc-400 italic">
              Transcription result will appear here...
            </p>
          {/if}
        </div>
      </div>

      <!-- Partial Results Stream -->
      <div>
        <h3 class="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
          Partial Results
        </h3>
        <p class="text-xs text-zinc-600 mb-2">
          Live updates from the streaming transcription protocol
        </p>
        <div class="bg-zinc-900/50 rounded-xl overflow-hidden">
          <div class="p-4 space-y-2 font-mono text-xs max-h-48 overflow-y-auto">
            {#if partialResults.length === 0}
              <!-- Placeholder showing expected format -->
              <div class="flex gap-3 text-zinc-600">
                <span class="shrink-0 w-14">[partial]</span>
                <span class="flex-1 italic">Waiting for transcription...</span>
                <span class="shrink-0">--ms</span>
              </div>
            {:else}
              {#each partialResults as result, i}
                <div class="flex gap-3 {result.type === 'final' ? 'text-zinc-200' : 'text-zinc-500'}">
                  <span class="shrink-0 w-14 {result.type === 'final' ? 'text-emerald-500' : ''}">[{result.type}]</span>
                  <span class="flex-1">"{result.text}"</span>
                  <span class="shrink-0 {result.type === 'final' ? 'text-zinc-500' : 'text-zinc-600'}">{result.processingTime}ms</span>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      </div>

      </div>
    </div>
  </div>
</div>
