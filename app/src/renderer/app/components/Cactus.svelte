<script lang="ts">
  import type { CactusMotionState } from '../recording-renderer-state';

  interface Props {
    class?: string;
    state?: CactusMotionState;
    level?: number;
    draw?: boolean;
    homeTarget?: boolean;
  }

  let {
    class: className = '',
    state = 'idle',
    level = 0,
    draw = false,
    homeTarget = false,
  }: Props = $props();

  let normalizedLevel = $derived(Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0);
</script>

<svg
  class="cactus {className} cactus--{state} {draw ? 'cactus--draw' : ''}"
  style="--lvl:{normalizedLevel}"
  viewBox="20 6 160 208"
  data-home-cactus={homeTarget ? 'true' : undefined}
  aria-hidden="true"
  focusable="false"
>
  <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path class="c-armL" pathLength="1" d="M100 152 H82 Q60 152 60 130 V106" stroke-width="28" />
    <path class="c-armR" pathLength="1" d="M100 124 H120 Q142 124 142 102 V78" stroke-width="28" />
    <path class="c-trunk" pathLength="1" d="M100 214 V50" stroke-width="38" />
  </g>
</svg>
