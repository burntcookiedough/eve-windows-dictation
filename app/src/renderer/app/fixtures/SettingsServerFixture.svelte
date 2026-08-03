<script lang="ts">
  import SettingsRow from '../components/SettingsRow.svelte';
  import SettingsSection from '../components/SettingsSection.svelte';
  import ServerView from '../views/ServerView.svelte';
  import Toggle from '../components/Toggle.svelte';

  type FixtureState = 'managed-ready' | 'managed-error' | 'external-ready' | 'managed-long';

  const params = new URLSearchParams(globalThis.location.search);
  const fixtureState = (params.get('state') ?? 'managed-ready') as FixtureState;
  const externalMode = fixtureState === 'external-ready';
  const longStrings = fixtureState === 'managed-long';
  const endpoint = longStrings
    ? 'ws://fixture-server-with-a-deliberately-long-hostname.example.internal:51717/transcribe'
    : externalMode
      ? 'ws://external-fixture.example:51717/transcribe'
      : 'ws://localhost:51717/transcribe';
  let externalEnabled = $state(externalMode);
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
            description="Management mode, endpoint, health, diagnostics, and recent logs."
            variant="content"
          >
            <div data-server-diagnostics class="min-w-0 space-y-6">
              <section data-server-management class="min-w-0 space-y-2" aria-labelledby="fixture-server-management-heading">
                <div class="min-w-0 px-1">
                  <h3 id="fixture-server-management-heading" class="text-sm font-semibold text-zinc-200">Management mode &amp; endpoint</h3>
                  <p class="mt-1 max-w-prose text-xs leading-5 text-zinc-500">Choose Eve-managed processing or connect to an external endpoint.</p>
                </div>
                <div data-server-mode-surface class="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
                  <SettingsRow label="Use external server" description="Connect to your own server and disable built-in server management">
                    <Toggle enabled={externalEnabled} label="Use external server" onchange={(enabled) => externalEnabled = enabled} />
                  </SettingsRow>
                  <div class="overflow-hidden border-t border-white/[0.08]">
                    {#if externalEnabled}
                      <div data-external-server-panel class="min-w-0 p-4">
                        <p class="text-sm text-zinc-200">Custom server endpoint</p>
                        <p class="mt-1 text-xs leading-5 text-zinc-500 [overflow-wrap:anywhere]">Eve connects to <span class="font-mono">/transcribe</span> at the configured endpoint.</p>
                        <label for="fixture-server-url" class="mt-3 block text-xs text-zinc-500">Endpoint</label>
                        <input id="fixture-server-url" aria-label="External server endpoint" value={endpoint} readonly class="mt-1 min-h-9 w-full max-w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-mono text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100" />
                      </div>
                    {/if}
                  </div>
                </div>
              </section>

              <ServerView embedded externalMode={externalMode} />
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  </main>
</div>
