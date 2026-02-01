<script lang="ts">
  function minimize() {
    window.murmurMain.minimizeWindow();
  }

  function maximize() {
    window.murmurMain.maximizeWindow();
  }

  function close() {
    window.murmurMain.closeWindow();
  }
</script>

<div class="flex items-center justify-between h-9 bg-[#0f0f0f] border-b border-[#1f1f1f] select-none">
  <div class="flex-1 flex items-center h-full pl-3 gap-2 [-webkit-app-region:drag]">
    <img src="/icon.png" alt="Murmur" class="w-5 h-5 rounded-[4px] shrink-0" />
    <span class="text-[13px] font-medium text-[#a1a1a1] tracking-wide">Murmur</span>
  </div>

  <div class="flex items-center gap-2 px-3 [-webkit-app-region:no-drag]">
    <button
      onclick={minimize}
      aria-label="Minimize"
      class="group relative flex items-center justify-center w-5 h-5 rounded-full bg-amber-500/30 hover:bg-amber-500/50 cursor-pointer transition-all duration-150"
    >
      <div class="w-2.5 h-0.5 rounded-full bg-amber-300 opacity-0 group-hover:opacity-100 transition-opacity duration-150"></div>
      <span class="absolute top-full mt-2 px-2 py-1 text-[11px] text-zinc-300 bg-zinc-800 rounded border border-zinc-700 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 whitespace-nowrap">Minimize</span>
    </button>

    <button
      onclick={maximize}
      aria-label="Maximize"
      class="group relative flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500/30 hover:bg-emerald-500/50 cursor-pointer transition-all duration-150"
    >
      <div class="w-2.5 h-2.5 rounded-[3px] border-[1.5px] border-emerald-300 opacity-0 group-hover:opacity-100 transition-opacity duration-150"></div>
      <span class="absolute top-full mt-2 px-2 py-1 text-[11px] text-zinc-300 bg-zinc-800 rounded border border-zinc-700 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 whitespace-nowrap">Maximize</span>
    </button>

    <button
      onclick={close}
      aria-label="Close"
      class="group relative flex items-center justify-center w-5 h-5 rounded-full bg-rose-500/30 hover:bg-rose-500/50 cursor-pointer transition-all duration-150"
    >
      <svg class="w-2.5 h-2.5 text-rose-300 opacity-0 group-hover:opacity-100 transition-opacity duration-150" viewBox="0 0 10 10">
        <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <span class="absolute top-full mt-2 px-2 py-1 text-[11px] text-zinc-300 bg-zinc-800 rounded border border-zinc-700 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 whitespace-nowrap">Close</span>
    </button>
  </div>
</div>
