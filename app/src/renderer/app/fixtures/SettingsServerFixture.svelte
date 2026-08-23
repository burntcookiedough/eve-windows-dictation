<script lang="ts">
  import SettingsSection from '../components/SettingsSection.svelte';
  import ServerView from '../views/ServerView.svelte';

  type FixtureState =
    | 'managed-ready'
    | 'managed-error'
    | 'managed-long'
    | 'managed-short'
    | 'managed-empty'
    | 'managed-log-error'
    | 'managed-log-loading';

  const params = new URLSearchParams(globalThis.location.search);
  const fixtureState = (params.get('state') ?? 'managed-ready') as FixtureState;
  const longStrings = fixtureState === 'managed-long';
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[#08090a] text-zinc-100">
  <header class="flex h-12 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
    <h1 class="min-w-0 text-sm font-semibold text-zinc-100 [overflow-wrap:anywhere]">Phase 3 Server &amp; diagnostics fixture</h1>
    <span data-fixture-state class="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400">{fixtureState}</span>
  </header>

  <main data-server-fixture-main class="min-h-0 min-w-0 flex-1 overflow-hidden">
    <div class="flex h-full min-h-0 min-w-0 w-full justify-center px-4 sm:px-6">
      <div data-server-fixture-scroll-owner class="min-h-0 min-w-0 w-full max-w-[720px] overflow-y-auto overscroll-contain pr-2">
        <div class="space-y-7 pb-8">
          <SettingsSection
            title="Server &amp; diagnostics"
            description="Server health, diagnostics, lifecycle, and recent logs."
            variant="content"
          >
            <div data-server-diagnostics class="min-w-0 space-y-6">
              <ServerView embedded />
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  </main>
</div>
