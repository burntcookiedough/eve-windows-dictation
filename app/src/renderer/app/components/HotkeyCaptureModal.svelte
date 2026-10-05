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
  let captureGeneration = 0;
  let wasOpen = false;

  $effect(() => {
    if (isOpen && !wasOpen) {
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
    const generation = ++captureGeneration;
    isCapturing = true;
    try {
      const result = await window.murmurMain.startHotkeyCapture();
      if (generation !== captureGeneration) return;
      onCapture(result.hotkey, result.displayName);
    } catch (error) {
      if (generation !== captureGeneration) return;
      console.error('Hotkey capture failed:', error);
      onCancel();
    } finally {
      if (generation === captureGeneration) {
        isCapturing = false;
      }
    }
  }

  function handleCancel() {
    captureGeneration += 1;
    isCapturing = false;
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
    class="hotkey-capture-layer"
    role="presentation"
    onclick={handleBackdropClick}
  >
    <!-- Modal -->
    <div
      bind:this={dialogRef}
      tabindex="-1"
      class="hotkey-capture-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hotkey-dialog-title"
      aria-describedby="hotkey-dialog-description"
    >
      <h2 id="hotkey-dialog-title" class="hotkey-capture-title">
        Recording Hotkey
      </h2>
      <p id="hotkey-dialog-description" class="hotkey-capture-description">
        Press any key combination...
      </p>

      <!-- Visual indicator -->
      <div class="hotkey-capture-indicator" aria-hidden="true">
        <span></span>
      </div>

      <!-- Cancel button -->
      <button
        bind:this={cancelButton}
        type="button"
        onclick={handleCancel}
        class="hotkey-capture-cancel"
      >
        Cancel
      </button>
    </div>
  </div>
{/if}

<style>
  .hotkey-capture-layer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
  }

  .hotkey-capture-panel {
    width: min(100%, 440px);
    border-top: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 12px 12px 0 0;
    padding: 24px 36px 28px;
    background: var(--bg, #0b0b0b);
    color: var(--fg, #ececec);
  }

  .hotkey-capture-title {
    margin: 0;
    font-size: 15px;
    font-weight: 400;
  }

  .hotkey-capture-description {
    margin: 6px 0 20px;
    color: var(--fg2, #9b9b9b);
    font-size: 12px;
  }

  .hotkey-capture-indicator {
    display: flex;
    min-height: 25px;
    align-items: center;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    padding: 10px 0;
  }

  .hotkey-capture-indicator span {
    width: 7px;
    height: 7px;
    border: 1px solid var(--fg, #ececec);
    border-radius: 50%;
    animation: capture-pulse 1.3s ease-in-out infinite alternate;
  }

  .hotkey-capture-cancel {
    border: 0;
    border-radius: 0;
    padding: 4px 0;
    background: transparent;
    color: var(--fg2, #9b9b9b);
    font: inherit;
    font-size: 11px;
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .hotkey-capture-cancel:hover {
    color: var(--fg, #ececec);
    text-decoration-color: currentColor;
  }

  .hotkey-capture-cancel:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  @keyframes capture-pulse {
    from { opacity: 0.35; transform: scale(0.8); }
    to { opacity: 1; transform: scale(1); }
  }

  @media (max-width: 480px) {
    .hotkey-capture-panel { padding-right: 22px; padding-left: 22px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .hotkey-capture-indicator span { animation: none; }
  }
</style>
