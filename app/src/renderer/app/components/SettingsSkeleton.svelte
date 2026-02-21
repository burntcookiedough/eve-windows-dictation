<script lang="ts">
  // Skeleton loading placeholder for the settings view.
  // Mirrors the layout of SettingsSection / SettingsRow with shimmer bones.
</script>

{#snippet bone(classes: string, delay: number)}
  <div
    class="skeleton-bone {classes}"
    style="animation-delay: {delay}ms"
  ></div>
{/snippet}

{#snippet sectionTitle(width: string, delay: number)}
  <div class="mb-3">
    {@render bone(`h-3.5 ${width} rounded-sm`, delay)}
  </div>
{/snippet}

{#snippet row(labelW: string, descW: string, control: string, delay: number)}
  <div class="flex items-center justify-between p-4 bg-zinc-900/50 rounded-xl w-full">
    <div class="flex-1 min-w-0 mr-4 space-y-2">
      {@render bone(`h-4 ${labelW} rounded`, delay)}
      {@render bone(`h-3 ${descW} rounded opacity-60`, delay + 30)}
    </div>
    <div class="shrink-0">
      {@render bone(control, delay)}
    </div>
  </div>
{/snippet}

<div class="space-y-8">
  <!-- Activation -->
  <section class="w-full">
    {@render sectionTitle('w-20', 0)}
    <div class="space-y-2 w-full">
      {@render row('w-12', 'w-56', 'h-7 w-12 rounded-lg', 0)}
      {@render row('w-28', 'w-44', 'h-8 w-[120px] rounded-lg', 50)}
    </div>
  </section>

  <!-- Audio -->
  <section class="w-full">
    {@render sectionTitle('w-12', 100)}
    <div class="space-y-2 w-full">
      {@render row('w-24', 'w-48', 'h-7 w-44 rounded-lg', 100)}
    </div>
  </section>

  <!-- Post-Processing -->
  <section class="w-full">
    {@render sectionTitle('w-28', 150)}
    <div class="space-y-2 w-full">
      {@render row('w-24', 'w-64', 'h-6 w-11 rounded-full', 150)}
      {@render row('w-24', 'w-60', 'h-6 w-11 rounded-full', 200)}
      <div class="p-4 rounded-xl border border-dashed border-zinc-700/50">
        {@render bone('h-4 w-56 rounded mx-auto opacity-40', 250)}
      </div>
    </div>
  </section>

  <!-- Recognition -->
  <section class="w-full">
    {@render sectionTitle('w-24', 300)}
    <div class="space-y-2 w-full">
      {@render row('w-28', 'w-64', 'h-6 w-11 rounded-full', 300)}
      <div class="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/50 p-4 space-y-3">
        {@render bone('h-4 w-52 rounded', 350)}
        {@render bone('h-3 w-full rounded opacity-50', 370)}
        {@render bone('h-[6.5rem] w-full rounded-lg opacity-30', 400)}
        <div class="flex items-center justify-between">
          {@render bone('h-3 w-16 rounded opacity-40', 430)}
          <div class="flex gap-2">
            {@render bone('h-7 w-16 rounded-lg opacity-50', 430)}
            {@render bone('h-7 w-16 rounded-lg opacity-50', 450)}
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Behavior -->
  <section class="w-full">
    {@render sectionTitle('w-18', 500)}
    <div class="space-y-2 w-full">
      {@render row('w-20', 'w-64', 'h-6 w-11 rounded-full', 500)}
      {@render row('w-20', 'w-56', 'h-6 w-11 rounded-full', 550)}
      {@render row('w-28', 'w-52', 'h-6 w-11 rounded-full', 600)}
      {@render row('w-28', 'w-56', 'h-6 w-11 rounded-full', 650)}
    </div>
  </section>

  <!-- Engine -->
  <section class="w-full">
    {@render sectionTitle('w-14', 700)}
    <div class="space-y-2 w-full">
      <div class="w-full rounded-xl border border-zinc-700/50 bg-zinc-900/50 p-4 space-y-3">
        {@render bone('h-4 w-36 rounded', 700)}
        <div class="space-y-2">
          {@render bone('h-16 w-full rounded-lg opacity-30', 750)}
          {@render bone('h-16 w-full rounded-lg opacity-30', 800)}
        </div>
      </div>
    </div>
  </section>

  <!-- About -->
  <section class="w-full">
    {@render sectionTitle('w-12', 850)}
    <div class="space-y-2 w-full">
      {@render row('w-14', 'w-44', 'h-7 w-16 rounded-lg', 850)}
    </div>
  </section>

  <!-- Server -->
  <section class="w-full">
    {@render sectionTitle('w-14', 900)}
    <div class="space-y-2 w-full">
      {@render row('w-36', 'w-80', 'h-6 w-11 rounded-full', 900)}
    </div>
  </section>
</div>
