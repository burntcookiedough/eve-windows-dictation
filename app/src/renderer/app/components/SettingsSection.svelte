<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    children: Snippet;
  }

  let { title, children }: Props = $props();
</script>

<section class="w-full" aria-label={title}>
  <h2 class="mb-3 text-xs font-medium text-zinc-400">
    {title}
  </h2>
  <div class="w-full overflow-hidden rounded-[10px] border border-white/10 bg-white/[0.025] divide-y divide-white/[0.08]">
    {@render children()}
  </div>
</section>
