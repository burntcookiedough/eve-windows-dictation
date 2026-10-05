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

<div data-primary-page={page} class="primary-page">
  <div
    data-primary-page-scroll
    data-scroll-owner={scrollOwner}
    data-home-scroll-owner={page === 'home' ? 'true' : undefined}
    class="primary-page__scroll"
  >
    <div data-primary-page-content class="primary-page__content {contentClass}">
      {@render children()}
    </div>
  </div>
</div>
