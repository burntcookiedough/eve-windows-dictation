<script lang="ts">
  import type { Hotkey } from '$shared/types';

  interface Props {
    isOpen: boolean;
    onCapture: (hotkey: Hotkey, displayName: string) => void;
    onCancel: () => void;
  }

  let { isOpen, onCapture, onCancel }: Props = $props();

  let isCapturing = $state(false);
  let dialogRef: HTMLDivElement | null = $state(null);
  let cancelButton: HTMLButtonElement | null = $state(null);
  let returnFocus: HTMLElement | null = null;
  let cancellationRequested = false;
  let wasOpen = false;

  $effect(() => {
    if (isOpen && !wasOpen) {
      cancellationRequested = false;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      queueMicrotask(() => cancelButton?.focus());
    } else if (!isOpen && wasOpen) {
      queueMicrotask(() => {
        if (returnFocus?.isConnected) returnFocus?.focus();
        returnFocus = null;
      });
    }
    wasOpen = isOpen;

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
      if (!cancellationRequested) {
        console.error('Hotkey capture failed:', error);
        onCancel();
      }
    } finally {
      isCapturing = false;
    }
  }

  function handleCancel() {
    cancellationRequested = true;
    void window.murmurMain.cancelHotkeyCapture();
    onCancel();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleCancel();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
      return;
    }

    if (e.key === 'Tab' && dialogRef) {
      const focusable = Array.from(
        dialogRef.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        e.preventDefault();
        dialogRef.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
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
    <div
      bind:this={dialogRef}
      tabindex="-1"
      class="w-[320px] rounded-[14px] border border-white/15 bg-[#111214] p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hotkey-dialog-title"
      aria-describedby="hotkey-dialog-description"
    >
      <h2 id="hotkey-dialog-title" class="text-lg font-medium text-zinc-100 mb-2 text-center">
        Recording Hotkey
      </h2>
      <p id="hotkey-dialog-description" class="text-sm text-zinc-400 mb-6 text-center">
        Press any key combination...
      </p>

      <!-- Visual indicator -->
      <div class="flex justify-center mb-6">
        <div class="flex h-16 w-16 items-center justify-center rounded-xl border border-white/15 bg-white/[0.06]">
          <div class="h-3 w-3 animate-pulse rounded-full bg-zinc-100 motion-reduce:animate-none"></div>
        </div>
      </div>

      <!-- Cancel button -->
      <button
        bind:this={cancelButton}
        type="button"
        onclick={handleCancel}
        class="w-full rounded-lg bg-white/[0.06] px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.09] hover:text-zinc-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100"
      >
        Cancel
      </button>
    </div>
  </div>
{/if}
