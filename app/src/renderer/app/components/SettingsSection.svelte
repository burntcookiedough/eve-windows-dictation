<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    children: Snippet;
  }

  let { title, children }: Props = $props();
</script>

<section class="w-full">
  <h2 class="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
    {title}
  </h2>
  <div class="space-y-2 w-full">
    {@render children()}
  </div>
</section>
