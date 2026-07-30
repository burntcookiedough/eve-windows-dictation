<script lang="ts">
  import { tick } from 'svelte';

  interface Props {
    text: string;
    isFinal: boolean;
    mode?: 'quick' | 'long';
  }

  let { text, isFinal, mode = 'quick' }: Props = $props();
  let scrollRef = $state<HTMLDivElement | null>(null);
  let isOverflowing = $state(false);

  // Keep the newest transcript line visible in the fixed two-line viewport.
  $effect(() => {
    if (!text) {
      isOverflowing = false;
      return;
    }

    if (!scrollRef) return;

    tick().then(() => {
      if (!scrollRef || !text) return;
      scrollRef.scrollTop = scrollRef.scrollHeight;
      isOverflowing = scrollRef.scrollHeight > scrollRef.clientHeight;
    });
  });
</script>

<div
  class="h-16 rounded-[20px] border border-white/15 bg-black/90 px-4 py-2.5
    {mode === 'long' ? 'w-full max-w-[320px]' : 'w-full max-w-[280px]'}"
  data-overflowing={isOverflowing}
>
  <div
    class="h-11 overflow-hidden {isOverflowing ? '[mask-image:linear-gradient(to_bottom,transparent_0%,black_28%,black_100%)]' : ''}"
    bind:this={scrollRef}
  >
    <p class="break-words text-center text-sm font-medium leading-[22px] text-zinc-100">
      {text}
    </p>
  </div>
</div>
