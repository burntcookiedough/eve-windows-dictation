# Main Window Frontend Reference

## Stack
- **Svelte 5** (with runes: `$state`, `$derived`, `$effect`)
- **Tailwind CSS v4** (import via `@import "tailwindcss"`)
- **TypeScript**

## File Structure
```
src/renderer/app/
├── index.html      # Entry point
├── main.ts         # Mounts Svelte app
├── app.css         # Global styles + CSS variables
├── App.svelte      # Root component
└── components/     # Your components go here
```

## Styling

### CSS Variables (defined in app.css)
```css
--color-background          /* #1a1a1a - main bg */
--color-background-secondary /* #252525 - cards, header */
--color-background-tertiary  /* #2f2f2f - hover states */
--color-text-primary        /* #ffffff */
--color-text-secondary      /* #a0a0a0 */
--color-text-muted          /* #666666 */
--color-accent              /* #3b82f6 - blue */
--color-accent-light        /* #60a5fa */
--color-success             /* #22c55e */
--color-error               /* #ef4444 */
--color-border              /* #3a3a3a */
```

### Usage
```svelte
<!-- Tailwind classes -->
<div class="p-4 bg-[var(--color-background-secondary)]">

<!-- Or in <style> block -->
<style>
  .my-class {
    background: var(--color-background-secondary);
    color: var(--color-text-primary);
  }
</style>
```

## Svelte 5 Patterns

### State
```svelte
<script lang="ts">
  let count = $state(0);
  let items = $state<string[]>([]);

  // Derived (computed)
  let doubled = $derived(count * 2);

  // Effects (side effects)
  $effect(() => {
    console.log('count changed:', count);
  });
</script>
```

### Components
```svelte
<!-- components/MyComponent.svelte -->
<script lang="ts">
  interface Props {
    title: string;
    count?: number;
  }
  let { title, count = 0 }: Props = $props();
</script>

<div>{title}: {count}</div>
```

### Events
```svelte
<button onclick={() => count++}>Click</button>
<input oninput={(e) => value = e.currentTarget.value} />
```

## IPC (Main Process Communication)

### Available API (window.murmurMain)
```ts
window.murmurMain.getSettings()      // Returns settings
window.murmurMain.closeWindow()      // Hide window
window.murmurMain.minimizeWindow()   // Minimize window
```

### Adding new IPC
1. Add channel to `src/shared/constants.ts`
2. Add handler in `src/main/preload/main.ts`
3. Add main process handler in `src/main/ipc/handlers.ts`

## Commands
```bash
bun run dev          # Dev mode (hot reload)
bun run build        # Production build
bun run package      # Build + package exe
```

## Tips
- Components go in `src/renderer/app/components/`
- Shared types in `src/shared/types.ts`
- Use `$lib/` alias for `src/renderer/lib/`
- Use `$shared/` alias for `src/shared/`
