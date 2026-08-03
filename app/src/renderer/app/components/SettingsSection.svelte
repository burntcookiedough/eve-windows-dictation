<script lang="ts">
  import type { Snippet } from 'svelte';

  type SectionVariant = 'rows' | 'panel' | 'content';

  interface Props {
    title: string;
    description?: string;
    id?: string;
    variant?: SectionVariant;
    children: Snippet;
  }

  let { title, description, id, variant = 'rows', children }: Props = $props();
  const componentId = $props.id();

  function slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  let headingId = $derived(id ?? `settings-section-${slugify(title) || 'section'}-${componentId}`);
  let descriptionId = $derived(description ? `${headingId}-description` : undefined);
</script>

<section class="w-full min-w-0" aria-labelledby={headingId} aria-describedby={descriptionId}>
  <div class="mb-3 min-w-0">
    <h2 id={headingId} class="text-sm font-semibold text-zinc-400">
      {title}
    </h2>
    {#if description}
      <p id={descriptionId} class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">{description}</p>
    {/if}
  </div>

  {#if variant === 'rows'}
    <div class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] divide-y divide-white/[0.08]">
      {@render children()}
    </div>
  {:else if variant === 'panel'}
    <div class="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
      {@render children()}
    </div>
  {:else}
    <div class="min-w-0">
      {@render children()}
    </div>
  {/if}
</section>
