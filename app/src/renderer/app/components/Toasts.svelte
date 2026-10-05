<script lang="ts">
  import { fade } from 'svelte/transition';
  import { toastState } from '$lib/toast.svelte';
</script>

<div class="app-toast-stack" aria-live="polite" aria-atomic="false">
  {#each toastState.toasts as toast (toast.id)}
    <div class="app-toast" role="status" transition:fade={{ duration: 180 }}>
      {toast.message}
    </div>
  {/each}
</div>
