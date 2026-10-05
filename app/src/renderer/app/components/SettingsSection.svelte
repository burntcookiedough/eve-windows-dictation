<script lang="ts">
  import type { Snippet } from 'svelte';
  import SettingsGroup from './SettingsGroup.svelte';

  type SectionVariant = 'rows' | 'panel' | 'content';

  interface Props {
    title: string;
    description?: string;
    id?: string;
    variant?: SectionVariant;
    revealOrder?: number;
    collapsible?: boolean;
    summary?: string;
    open?: boolean;
    children: Snippet;
  }

  let { title, description, id, variant = 'rows', revealOrder, collapsible = false, summary, open = false, children }: Props = $props();
  const componentId = $props.id();

  function slugify(value: string): string {
    return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  let headingId = $derived(id ?? 'settings-section-' + (slugify(title) || 'section') + '-' + componentId);
  let descriptionId = $derived(description ? headingId + '-description' : undefined);
</script>

{#if collapsible}
  <SettingsGroup
    {title}
    {description}
    {id}
    {variant}
    {summary}
    {open}
    headingLevel={2}
    collapsible
    {children}
  />
{:else}
  <section
    class="settings-section"
    aria-labelledby={headingId}
    aria-describedby={descriptionId}
    data-r={revealOrder === undefined ? undefined : ''}
    style={revealOrder === undefined ? undefined : `--r: ${revealOrder}`}
  >
    <h2 id={headingId} class="settings-section-heading">{title}</h2>
    {#if description}<p id={descriptionId} class="settings-section-description">{description}</p>{/if}
    <div class="settings-section-content">
      {@render children()}
    </div>
  </section>
{/if}

<style>
  .settings-section {
    min-width: 0;
    margin-top: 26px;
    border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.07));
  }

  .settings-section:first-of-type {
    margin-top: 0;
  }

  .settings-section-heading {
    margin: 0;
    padding-bottom: 8px;
    color: var(--fg3, #565656);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.12em;
    line-height: normal;
    text-transform: uppercase;
  }

  .settings-section-description {
    margin: 0 0 9px;
    color: var(--fg2, #9b9b9b);
    font-size: 11px;
    line-height: 1.5;
  }

  .settings-section-content {
    min-width: 0;
  }
</style>
