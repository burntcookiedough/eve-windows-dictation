<script lang="ts">
  import { fly } from 'svelte/transition';
  import { toastState } from '$lib/toast.svelte';
</script>

<div
  class="fixed inset-x-0 bottom-16 z-50 flex flex-col items-center gap-2 pointer-events-none"
  aria-live="polite"
  aria-atomic="false"
>
  {#each toastState.toasts as t (t.id)}
    <div
      in:fly={{ y: 12, duration: 200, opacity: 0 }}
      out:fly={{ y: 12, duration: 150, opacity: 0 }}
      class="px-4 py-2 rounded-full text-sm font-medium shadow-lg backdrop-blur-sm pointer-events-auto
        {t.type === 'success' ? 'bg-emerald-600/90 text-white' : ''}
        {t.type === 'error' ? 'bg-red-600/90 text-white' : ''}
        {t.type === 'info' ? 'bg-zinc-700/90 text-zinc-100' : ''}"
    >
      <div class="flex items-center gap-2">
        {#if t.type === 'success'}
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        {:else if t.type === 'error'}
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        {/if}
        <span>{t.message}</span>
      </div>
    </div>
  {/each}
</div>
