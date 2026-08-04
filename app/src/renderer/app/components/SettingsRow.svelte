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
  data-settings-row
  class="grid min-h-12 min-w-0 w-full grid-cols-[minmax(0,1fr)_minmax(5rem,45%)] items-center gap-x-4 px-4 py-3 transition-colors hover:bg-white/[0.035] sm:gap-x-6 {notImplemented ? 'outline outline-1 outline-red-800' : ''}"
  role="group"
  aria-label={description ? `${label}. ${description}` : label}
>
  <div class="min-w-0">
    <p class="text-[13px] leading-5 text-zinc-100 [overflow-wrap:anywhere]">{label}</p>
    {#if description}
      <p class="mt-0.5 text-[11px] leading-4 text-zinc-500 [overflow-wrap:anywhere]">{description}</p>
    {/if}
  </div>
  <div
    data-settings-control
    class="flex min-w-0 w-full max-w-full items-center justify-end justify-self-end
      [&>button]:max-w-full [&>div]:max-w-full [&>input]:max-w-full [&>select]:max-w-full [&>textarea]:max-w-full
      [&>div]:min-w-0
      [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-zinc-100
      [&_input]:focus-visible:outline-none [&_input]:focus-visible:ring-2 [&_input]:focus-visible:ring-zinc-100
      [&_select]:focus-visible:outline-none [&_select]:focus-visible:ring-2 [&_select]:focus-visible:ring-zinc-100
      [&_textarea]:focus-visible:outline-none [&_textarea]:focus-visible:ring-2 [&_textarea]:focus-visible:ring-zinc-100"
  >
    {@render children()}
  </div>
</div>
