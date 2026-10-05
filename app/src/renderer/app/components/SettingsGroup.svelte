<script lang="ts">
  import type { Snippet } from 'svelte';

  type GroupVariant = 'rows' | 'panel' | 'content';

  interface Props {
    title: string;
    description?: string;
    id?: string;
    variant?: GroupVariant;
    collapsible?: boolean;
    summary?: string;
    open?: boolean;
    headingLevel?: 2 | 3;
    children: Snippet;
  }

  let {
    title,
    description,
    id,
    variant = 'rows',
    collapsible = false,
    summary,
    open = false,
    headingLevel = 3,
    children,
  }: Props = $props();
  const componentId = $props.id();

  function slugify(value: string): string {
    return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  let headingId = $derived(id ?? 'settings-group-' + (slugify(title) || 'group') + '-' + componentId);
  let descriptionId = $derived(description ? headingId + '-description' : undefined);
  let expanded = $state(false);

  $effect(() => {
    if (open) expanded = true;
  });
</script>

{#if collapsible}
  <details data-settings-group data-variant={variant} class="settings-disclosure" bind:open={expanded}>
    <summary
      class="settings-disclosure-summary"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
    >
      <span id={headingId}>{title}</span>
      <span class="settings-disclosure-action" aria-hidden="true">{expanded ? 'hide' : 'show'} <span class="chevron">›</span></span>
    </summary>
    {#if summary}<p data-settings-summary class="visually-hidden">{summary}</p>{/if}
    {#if description}<p id={descriptionId} class="settings-disclosure-description">{description}</p>{/if}
    <div class="settings-disclosure-content">
      <div class="settings-disclosure-clip">
        <div data-settings-group-surface class="settings-group-content">
          {@render children()}
        </div>
      </div>
    </div>
  </details>
{:else}
  <section data-settings-group data-variant={variant} class="settings-group" aria-labelledby={headingId} aria-describedby={descriptionId}>
    {#if headingLevel === 2}
      <h2 id={headingId} class="settings-group-heading">{title}</h2>
    {:else}
      <h3 id={headingId} class="settings-group-heading">{title}</h3>
    {/if}
    {#if summary}<p class="settings-group-summary">{summary}</p>{/if}
    {#if description}<p id={descriptionId} class="settings-group-description">{description}</p>{/if}
    <div data-settings-group-surface class="settings-group-content">
      {@render children()}
    </div>
  </section>
{/if}

<style>
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .settings-group,
  .settings-group-content {
    min-width: 0;
  }

  .settings-group-heading,
  .settings-disclosure-summary {
    margin: 0;
    padding: 0 0 8px;
    color: var(--fg3, #565656);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.12em;
    line-height: 1.4;
    text-transform: uppercase;
  }

  .settings-group-summary,
  .settings-group-description,
  .settings-disclosure-description {
    margin: -2px 0 10px;
    color: var(--fg2, #9b9b9b);
    font-size: 11px;
    line-height: 1.5;
  }

  .settings-disclosure {
    min-width: 0;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.07));
  }

  .settings-disclosure-summary {
    display: flex;
    min-height: 46px;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0;
    color: var(--fg2, #9b9b9b);
    cursor: pointer;
    list-style: none;
  }

  .settings-disclosure-summary::-webkit-details-marker {
    display: none;
  }

  .settings-disclosure-summary:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  .settings-disclosure-action {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--fg3, #565656);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: lowercase;
  }

  .chevron {
    display: inline-block;
    font-family: "Geist", "Segoe UI Variable", sans-serif;
    font-size: 16px;
    line-height: 1;
    transition: transform 300ms var(--ease, cubic-bezier(.2, .7, .2, 1));
  }

  .settings-disclosure[open] .chevron {
    transform: rotate(90deg);
  }

  .settings-disclosure-description {
    margin: 0 0 9px;
  }

  .settings-disclosure-content {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 500ms var(--ease, cubic-bezier(.2, .7, .2, 1));
  }

  .settings-disclosure[open] .settings-disclosure-content {
    grid-template-rows: 1fr;
  }

  .settings-disclosure-clip {
    min-height: 0;
    overflow: hidden;
  }

  .settings-group-content :global([data-settings-row]:first-child),
  .settings-disclosure-clip :global([data-settings-row]:first-child) {
    border-top: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .chevron,
    .settings-disclosure-content {
      transition-duration: 1ms;
    }
  }
</style>
