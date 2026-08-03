<script lang="ts">
  import type { Snippet } from 'svelte';

  type GroupVariant = 'rows' | 'panel';

  interface Props {
    title: string;
    description?: string;
    id?: string;
    variant?: GroupVariant;
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

  let headingId = $derived(id ?? `settings-group-${slugify(title) || 'group'}-${componentId}`);
  let descriptionId = $derived(description ? `${headingId}-description` : undefined);
</script>

<section data-settings-group class="min-w-0 space-y-2" aria-labelledby={headingId} aria-describedby={descriptionId}>
  <div class="min-w-0 px-1">
    <h3 id={headingId} class="text-xs font-medium text-zinc-300">{title}</h3>
    {#if description}
      <p id={descriptionId} class="mt-1 max-w-prose text-[11px] leading-4 text-zinc-500">{description}</p>
    {/if}
  </div>

  {#if variant === 'rows'}
    <div data-settings-group-surface class="min-w-0 w-full divide-y divide-white/[0.08] rounded-xl border border-white/10 bg-white/[0.025]">
      {@render children()}
    </div>
  {:else}
    <div data-settings-group-surface class="min-w-0 w-full rounded-xl border border-white/10 bg-white/[0.025] p-4 sm:p-5">
      {@render children()}
    </div>
  {/if}
</section>
