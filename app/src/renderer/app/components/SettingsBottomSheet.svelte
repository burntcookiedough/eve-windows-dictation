<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    children: Snippet;
  }

  let { open, title, description, onClose, children }: Props = $props();
  const componentId = $props.id();
  const titleId = `settings-sheet-title-${componentId}`;
  const descriptionId = `settings-sheet-description-${componentId}`;
  let panel: HTMLElement | null = $state(null);
  let returnFocus: HTMLElement | null = null;
  let wasOpen = false;
  let focusGeneration = 0;

  function focusableElements(): HTMLElement[] {
    if (!open || !panel || panel.closest('[inert]')) return [];
    return Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) =>
      element.getClientRects().length > 0
      && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    );
  }

  $effect(() => {
    if (open && !wasOpen) {
      const generation = ++focusGeneration;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      queueMicrotask(() => {
        if (!open || generation !== focusGeneration) return;
        const first = panel?.querySelector<HTMLElement>('[data-sheet-initial-focus]') ?? focusableElements()[0];
        (first ?? panel)?.focus({ preventScroll: true });
      });
    } else if (!open && wasOpen) {
      const generation = ++focusGeneration;
      const opener = returnFocus;
      queueMicrotask(() => {
        if (open || generation !== focusGeneration) return;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        if (returnFocus === opener) returnFocus = null;
      });
    }
    wasOpen = open;
  });

  function handleKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = focusableElements();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      panel?.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div class="sheet-layer" class:open aria-hidden={!open} inert={!open}>
  <button
    type="button"
    class="sheet-scrim"
    tabindex={open ? 0 : -1}
    aria-label={'Close ' + title}
    onclick={onClose}
  ></button>
  <div
    bind:this={panel}
    class="sheet-panel"
    role="dialog"
    aria-modal={open}
    aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined}
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <h2 id={titleId}>{title}</h2>
    {#if description}<p id={descriptionId} class="sheet-description">{description}</p>{/if}
    <div class="sheet-content">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .sheet-layer {
    position: fixed;
    inset: 0;
    z-index: 60;
    visibility: hidden;
    pointer-events: none;
    transition: visibility 550ms step-end;
  }

  .sheet-layer.open {
    visibility: visible;
    pointer-events: auto;
    transition: visibility 0s;
  }

  .sheet-scrim {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    padding: 0;
    background: rgba(0, 0, 0, 0.55);
    opacity: 0;
    transition: opacity 400ms ease;
  }

  .sheet-layer.open .sheet-scrim {
    opacity: 1;
  }

  .sheet-panel {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    max-height: 82%;
    overflow: auto;
    padding: 26px 36px;
    border-top: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 12px 12px 0 0;
    background: var(--bg, #0b0b0b);
    color: var(--fg, #ececec);
    transform: translateY(102%);
    transition: transform 550ms var(--ease-io, cubic-bezier(.7, 0, .2, 1));
  }

  .sheet-layer.open .sheet-panel {
    transform: translateY(0);
  }

  .sheet-panel h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 400;
  }

  .sheet-description {
    margin: 5px 0 0;
    color: var(--fg2, #9b9b9b);
    font-size: 12.5px;
  }

  .sheet-content {
    margin-top: 18px;
  }

  .sheet-panel :global(:focus-visible) {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  @media (max-width: 480px) {
    .sheet-panel {
      padding: 24px 22px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet-layer,
    .sheet-scrim,
    .sheet-panel {
      transition-duration: 1ms;
    }
  }
</style>
