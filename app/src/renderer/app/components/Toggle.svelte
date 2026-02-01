<script lang="ts">
  interface Props {
    enabled: boolean;
    onchange?: (enabled: boolean) => void;
    label?: string;
  }

  let { enabled, onchange, label }: Props = $props();

  function handleClick() {
    onchange?.(!enabled);
  }
</script>

<button
  onclick={handleClick}
  class="w-11 h-6 rounded-full relative transition-colors duration-200 shrink-0 cursor-pointer
    focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-zinc-900 focus:ring-zinc-600
    {enabled ? 'bg-emerald-600' : 'bg-zinc-700 hover:bg-zinc-600'}"
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
