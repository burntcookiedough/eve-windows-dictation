<script lang="ts">
  import type { Snippet } from 'svelte';

  type PrimaryPageName = 'home' | 'history' | 'insights' | 'settings';

  interface Props {
    page: PrimaryPageName;
    scrollOwner?: string;
    contentClass?: string;
    children: Snippet;
  }

  let {
    page,
    scrollOwner = page,
    contentClass = '',
    children,
  }: Props = $props();
</script>

<div data-primary-page={page} class="h-full min-h-0 min-w-0 overflow-hidden">
  <div
    data-primary-page-scroll
    data-scroll-owner={scrollOwner}
    data-home-scroll-owner={page === 'home' ? 'true' : undefined}
    class="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none] [scroll-behavior:auto] [scrollbar-gutter:stable]"
  >
    <div
      data-primary-page-content
      class="mx-auto min-h-full min-w-0 w-full max-w-4xl px-4 py-4 sm:px-6 sm:py-6 {contentClass}"
    >
      {@render children()}
    </div>
  </div>
</div>
