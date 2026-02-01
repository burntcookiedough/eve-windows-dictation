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

<div class="text-display" class:final={isFinal}>
  <div class="text-content" class:overflowing={isOverflowing} bind:this={scrollRef}>
    <p>{text}</p>
  </div>
</div>

<style>
  .text-display {
    max-width: 575px;
    background: rgb(0, 0, 0);
    border-radius: 24px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    padding: 10px 14px;
  }

  .text-content {
    max-height: 120px;
    overflow-y: auto;

    /* Hide scrollbar */
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  /* Only show fade when content is overflowing */
  .text-content.overflowing {
    mask-image: linear-gradient(to bottom, transparent 0%, black 30%, black 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 30%, black 100%);
  }

  .text-content::-webkit-scrollbar {
    display: none;
  }

  .text-display.final {
    /* No change on success */
  }

  p {
    color: #ffffff;
    font-size: 16px;
    font-weight: 500;
    line-height: 1.5;
    text-align: center;
    margin: 0;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
</style>
