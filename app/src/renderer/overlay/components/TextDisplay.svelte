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

  // Auto-scroll to bottom when text changes and check overflow
  $effect(() => {
    if (text && scrollRef) {
      tick().then(() => {
        scrollRef!.scrollTop = scrollRef!.scrollHeight;
        isOverflowing = scrollRef!.scrollHeight > scrollRef!.clientHeight;
      });
    }
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
    <p class="line-clamp-2 break-words text-center text-sm font-medium leading-[22px] text-zinc-100">
      {text}
    </p>
  </div>
</div>
