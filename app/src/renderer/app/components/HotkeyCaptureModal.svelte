<script lang="ts">
  import type { Hotkey } from '$shared/types';

  interface Props {
    isOpen: boolean;
    onCapture: (hotkey: Hotkey, displayName: string) => void;
    onCancel: () => void;
  }

  let { isOpen, onCapture, onCancel }: Props = $props();

  let isCapturing = $state(false);

  $effect(() => {
    if (isOpen && !isCapturing) {
      startCapture();
    }
  });

  async function startCapture() {
    isCapturing = true;
    try {
      const result = await window.murmurMain.startHotkeyCapture();
      onCapture(result.hotkey, result.displayName);
    } catch (error) {
      console.error('Hotkey capture failed:', error);
      onCancel();
    } finally {
      isCapturing = false;
    }
  }

  function handleCancel() {
    window.murmurMain.cancelHotkeyCapture();
    onCancel();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleCancel();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      handleCancel();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if isOpen}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
    role="presentation"
    onclick={handleBackdropClick}
  >
    <!-- Modal -->
    <div class="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-[320px] shadow-2xl">
      <h2 class="text-lg font-medium text-zinc-100 mb-2 text-center">
        Recording Hotkey
      </h2>
      <p class="text-sm text-zinc-400 mb-6 text-center">
        Press any key combination...
      </p>

      <!-- Visual indicator -->
      <div class="flex justify-center mb-6">
        <div class="w-16 h-16 rounded-xl bg-zinc-800 border-2 border-zinc-600 flex items-center justify-center">
          <div class="w-3 h-3 bg-amber-500 rounded-full animate-pulse"></div>
        </div>
      </div>

      <!-- Cancel button -->
      <button
        onclick={handleCancel}
        class="w-full py-2 px-4 text-sm text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors cursor-pointer"
      >
        Cancel
      </button>
    </div>
  </div>
{/if}
