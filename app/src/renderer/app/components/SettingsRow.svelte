<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    label: string;
    description?: string;
    notImplemented?: boolean;
    children: Snippet;
  }

  let { label, description, children }: Props = $props();
</script>

<div
  data-settings-row
  class="settings-row"
  role="group"
  aria-label={description ? label + '. ' + description : label}
>
  <span class="settings-row-label">{label}</span>
  <div data-settings-control class="settings-row-control">
    {@render children()}
  </div>
</div>

<style>
  .settings-row {
    display: flex;
    min-width: 0;
    min-height: 46px;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-top: 1px solid var(--line, rgba(255, 255, 255, 0.07));
    color: var(--fg, #ececec);
    font-size: 13.5px;
    line-height: 1.4;
  }

  .settings-row-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .settings-row-control {
    display: flex;
    min-width: 0;
    max-width: 62%;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    color: var(--fg2, #9b9b9b);
    text-align: right;
  }

  .settings-row :global(:focus-visible) {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  @media (max-width: 480px) {
    .settings-row {
      gap: 10px;
      font-size: 12.5px;
    }

    .settings-row-control {
      max-width: 64%;
      gap: 9px;
    }

    .settings-row :global(button) {
      max-width: 100%;
      overflow-wrap: anywhere;
      white-space: normal;
    }
  }
</style>
