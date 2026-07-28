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
  type="button"
  onclick={handleClick}
  {disabled}
  class="relative min-h-6 min-w-10 w-11 h-6 rounded-full transition-colors duration-[120ms] shrink-0
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08090a]
    {disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
    {enabled && !disabled ? 'bg-zinc-100' : 'bg-zinc-700'}
    {!enabled && !disabled ? 'hover:bg-zinc-600' : ''}"
  role="switch"
  aria-checked={enabled}
  aria-label={label}
>
  <span
    class="block w-[18px] h-[18px] rounded-full
      absolute top-[3px] transition-all duration-200 ease-in-out
      {enabled ? 'bg-zinc-950' : 'bg-white'}
      {enabled ? 'left-[23px]' : 'left-[3px]'}"
  ></span>
</button>
