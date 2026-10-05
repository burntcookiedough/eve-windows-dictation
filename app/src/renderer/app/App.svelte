<script lang="ts">
  import { onMount } from 'svelte';
  import TitleBar from './components/TitleBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import ModelProgressBanner from './components/ModelProgressBanner.svelte';
  import LaunchIntro from './components/LaunchIntro.svelte';
  import HistoryView from './views/HistoryView.svelte';
  import InsightsView from './views/InsightsView.svelte';
  import SettingsView from './views/SettingsView.svelte';
  import HomeView from './views/HomeView.svelte';
  import TestView from './views/TestView.svelte';
  import { disposeServerStatus, initializeServerStatus, serverStatusState } from './server-status';
  import { initializeRecordingRendererState } from './recording-renderer-state';
  import { hasVisibleNavigationBlocker } from './navigation-shortcuts';
  import type { Settings } from '$shared/types';

  type PrimaryView = 'home' | 'insights' | 'history' | 'settings';
  type View = PrimaryView | 'test';

  let activeView = $state<View>('home');
  let visited = $state<Record<PrimaryView, boolean>>({
    home: true,
    insights: false,
    history: false,
    settings: false,
  });
  let testVisited = $state(false);
  let appearance = $state<Settings['appearance']>('dark');
  let introVisible = $state(true);
  let introGeneration = $state(0);
  let navElement: HTMLElement | null = null;
  let indicator = $state({ left: 0, width: 0 });
  let serverSnapshot = $derived($serverStatusState);
  let progressPercent = $derived(serverSnapshot.state?.modelDownload?.progress_percent);
  let modelName = $derived(serverSnapshot.state?.modelDownload?.model ?? serverSnapshot.state?.engineStatus?.info?.model);

  const primaryTabs: Array<{ id: PrimaryView; label: string }> = [
    { id: 'home', label: 'home' },
    { id: 'insights', label: 'insights' },
    { id: 'history', label: 'history' },
    { id: 'settings', label: 'settings' },
  ];

  function updateIndicator(): void {
    if (!navElement || activeView === 'test') return;
    const button = navElement.querySelector<HTMLButtonElement>(`[data-view="${activeView}"]`);
    if (!button) return;
    indicator = { left: button.offsetLeft + 15, width: Math.max(0, button.offsetWidth - 30) };
  }

  function selectView(candidate: PrimaryView): void {
    visited[candidate] = true;
    activeView = candidate;
    requestAnimationFrame(updateIndicator);
  }

  function replayIntro(): void {
    selectView('home');
    introGeneration += 1;
    introVisible = true;
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable
      || target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null;
  }

  function hasOpenMenuOrDialog(): boolean {
    return hasVisibleNavigationBlocker(
      document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"]'),
      (element) => {
        const style = window.getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
      }
    );
  }

  function handleGlobalShortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (isEditableTarget(event.target) || hasOpenMenuOrDialog()) return;

    const next = primaryTabs.find((tab, index) => event.key === String(index + 1))?.id;
    if (next) {
      if (introVisible) return;
      event.preventDefault();
      selectView(next);
      return;
    }

    if (import.meta.env.DEV && event.key === '0') {
      event.preventDefault();
      testVisited = true;
      activeView = 'test';
    }
  }

  onMount(() => {
    initializeServerStatus();
    const stopRecording = initializeRecordingRendererState();
    let settingsRevision = 0;
    const stopSettings = window.murmurMain.onSettingsChanged((settings) => {
      settingsRevision += 1;
      appearance = settings.appearance;
    });
    const resizeObserver = new ResizeObserver(updateIndicator);
    if (navElement) resizeObserver.observe(navElement);
    window.addEventListener('resize', updateIndicator);
    window.addEventListener('keydown', handleGlobalShortcut);
    requestAnimationFrame(updateIndicator);

    void window.murmurMain.getSettings().then((settings) => {
      if (settingsRevision === 0) appearance = settings.appearance;
    }).catch(() => {
      // Dark mode is the persisted default when settings cannot be read.
    });

    return () => {
      stopRecording();
      stopSettings();
      disposeServerStatus();
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateIndicator);
      window.removeEventListener('keydown', handleGlobalShortcut);
    };
  });
</script>

<div class="eve-shell" class:eve-shell--light={appearance === 'light'} class:app-shell--booting={introVisible}>
  <TitleBar />

  <ModelProgressBanner
    visible={activeView === 'history' || activeView === 'insights'}
    onNavigate={() => selectView('settings')}
  />
  <p class="sr-only" aria-live="polite" aria-atomic="true">{serverSnapshot.announcement}</p>

  <main id="main-content" class="app-pages" tabindex="-1">
    {#if visited.home}
      <div
        class="app-page-layer"
        class:app-page-layer--active={activeView === 'home'}
        aria-hidden={activeView !== 'home'}
        inert={activeView !== 'home'}
      >
        <HomeView onNavigate={selectView} />
      </div>
    {/if}

    {#if visited.insights}
      <div
        class="app-page-layer"
        class:app-page-layer--active={activeView === 'insights'}
        aria-hidden={activeView !== 'insights'}
        inert={activeView !== 'insights'}
      >
        <InsightsView />
      </div>
    {/if}

    {#if visited.history}
      <div
        class="app-page-layer"
        class:app-page-layer--active={activeView === 'history'}
        aria-hidden={activeView !== 'history'}
        inert={activeView !== 'history'}
      >
        <HistoryView />
      </div>
    {/if}

    {#if visited.settings}
      <div
        class="app-page-layer"
        class:app-page-layer--active={activeView === 'settings'}
        aria-hidden={activeView !== 'settings'}
        inert={activeView !== 'settings'}
      >
        <SettingsView onReplayIntro={replayIntro} />
      </div>
    {/if}

    {#if import.meta.env.DEV && testVisited}
      <div
        class="app-page-layer"
        class:app-page-layer--active={activeView === 'test'}
        aria-hidden={activeView !== 'test'}
        inert={activeView !== 'test'}
      >
        <TestView />
      </div>
    {/if}
  </main>

  <nav class="app-nav" aria-label="Main navigation" bind:this={navElement}>
    {#each primaryTabs as tab (tab.id)}
      <button
        class="app-nav__item"
        type="button"
        data-view={tab.id}
        onclick={() => selectView(tab.id)}
        aria-current={activeView === tab.id ? 'page' : undefined}
      >
        {tab.label}
      </button>
    {/each}
    <span class="app-nav__indicator" aria-hidden="true" style={`left:${indicator.left}px;width:${indicator.width}px`}></span>
  </nav>

  <Toasts />

  {#if introVisible}
    {#key introGeneration}
      <LaunchIntro
        phase={serverSnapshot.phase}
        modelName={modelName}
        progressPercent={progressPercent}
        onComplete={() => { introVisible = false; }}
      />
    {/key}
  {/if}
</div>
