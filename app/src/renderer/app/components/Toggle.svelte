<script lang="ts">
  interface Props {
    enabled: boolean;
    onchange?: (enabled: boolean) => void;
    label?: string;
    disabled?: boolean;
  }

  let { enabled, onchange, label, disabled = false }: Props = $props();

  function handleClick() {
    if (disabled) return;
    onchange?.(!enabled);
  }
</script>

<button
  onclick={handleClick}
  {disabled}
  class="w-11 h-6 rounded-full relative transition-colors duration-200 shrink-0
    focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-zinc-900 focus:ring-zinc-600
    {disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
    {enabled && !disabled ? 'bg-emerald-600' : 'bg-zinc-700'}
    {!enabled && !disabled ? 'hover:bg-zinc-600' : ''}"
  role="switch"
  aria-checked={enabled}
  aria-label={label}
>
  <span
    class="block w-[18px] h-[18px] bg-white rounded-full shadow-sm
      absolute top-[3px] transition-all duration-200 ease-in-out
      {enabled ? 'left-[23px]' : 'left-[3px]'}"
  ></span>
</button>
