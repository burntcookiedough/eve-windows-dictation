<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    description?: string;
    children: Snippet;
  }

  let { label, description, children }: Props = $props();
</script>

<div class="flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl hover:bg-zinc-900 transition-colors w-full">
  <div class="flex-1 min-w-0 mr-4">
    <p class="text-sm text-zinc-200">{label}</p>
    {#if description}
      <p class="text-xs text-zinc-500 mt-0.5">{description}</p>
    {/if}
  </div>
  <div class="shrink-0">
    {@render children()}
  </div>
</div>
