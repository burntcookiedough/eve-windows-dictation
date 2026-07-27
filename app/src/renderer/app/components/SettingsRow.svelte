<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    description?: string;
    notImplemented?: boolean;
    children: Snippet;
  }

  let { label, description, notImplemented = false, children }: Props = $props();
</script>

<div
  class="flex min-h-12 w-full items-center justify-between px-3 py-2.5 transition-colors hover:bg-white/[0.035] {notImplemented ? 'outline outline-1 outline-red-800' : ''}"
  role="group"
  aria-label={description ? `${label}. ${description}` : label}
>
  <div class="flex-1 min-w-0 mr-4">
    <p class="text-[13px] leading-5 text-zinc-100">{label}</p>
    {#if description}
      <p class="mt-0.5 text-[11px] leading-4 text-zinc-500">{description}</p>
    {/if}
  </div>
  <div class="shrink-0">
    {@render children()}
  </div>
</div>
