<script lang="ts">
  import { tick } from 'svelte';

  interface Props {
    text: string;
    isFinal: boolean;
  }

  let { text, isFinal }: Props = $props();
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

<div class="max-w-xl bg-black rounded-3xl border border-zinc-500/25 px-3.5 py-2.5">
  <div
    class="max-h-30 overflow-y-auto scrollbar-hide {isOverflowing ? '[mask-image:linear-gradient(to_bottom,transparent_0%,black_30%,black_100%)]' : ''}"
    bind:this={scrollRef}
  >
    <p class="text-zinc-100 text-base font-medium leading-relaxed text-center break-words">
      {text}
    </p>
  </div>
</div>
