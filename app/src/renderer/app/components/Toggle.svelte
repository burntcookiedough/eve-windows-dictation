<script lang="ts">
  interface Props {
    enabled: boolean;
    onchange?: (enabled: boolean) => void;
    label?: string;
    disabled?: boolean;
  }

  let { enabled, onchange, label, disabled = false }: Props = $props();

  function handleClick(): void {
    if (!disabled) onchange?.(!enabled);
  }
</script>

<button
  type="button"
  class="settings-switch"
  onclick={handleClick}
  {disabled}
  role="switch"
  aria-checked={enabled}
  aria-label={label}
>
  <span class="settings-switch-knob" aria-hidden="true"></span>
</button>

<style>
  .settings-switch {
    position: relative;
    display: inline-flex;
    width: 40px;
    height: 40px;
    flex: none;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 50%;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }

  .settings-switch::before {
    position: absolute;
    width: 30px;
    height: 16px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    border-radius: 999px;
    background: transparent;
    content: "";
    transition: background 300ms ease, border-color 300ms ease;
  }

  .settings-switch:hover:not(:disabled)::before {
    border-color: var(--fg2, #9b9b9b);
  }

  .settings-switch:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  .settings-switch[aria-checked="true"] {
    background: transparent;
  }

  .settings-switch[aria-checked="true"]::before {
    border-color: var(--fg, #ececec);
    background: var(--fg, #ececec);
  }

  .settings-switch:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

  .settings-switch-knob {
    position: absolute;
    top: 15px;
    left: 7px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--fg3, #565656);
    transition: transform 400ms var(--ease, cubic-bezier(.2, .7, .2, 1)), background 300ms ease;
  }

  .settings-switch[aria-checked="true"] .settings-switch-knob {
    transform: translateX(14px);
    background: var(--bg, #0b0b0b);
  }

  @media (prefers-reduced-motion: reduce) {
    .settings-switch,
    .settings-switch::before,
    .settings-switch-knob {
      transition-duration: 1ms;
    }
  }
</style>
