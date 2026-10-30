<script lang="ts">
  import type { PillView } from '../pill-view';

  interface Props {
    view: PillView;
    levels: number[];
  }

  let { view, levels }: Props = $props();

  // Each lobe reads the voice a moment apart, so the bead stays asymmetric and
  // alive while real audio remains the only thing moving it.
  function lobe(framesAgo: number): number {
    if (!view.isOpen || view.phase !== 'live' || view.isAlert) return 0;
    return Math.sqrt(Math.max(0, Math.min(1, levels[levels.length - framesAgo] ?? 0)));
  }

  const left = $derived(lobe(1));
  const right = $derived(lobe(5));
  const middle = $derived(lobe(10));

  // The label stays put while the pill closes so it clips away instead of blinking out.
  let lastLabel = '';
  const label = $derived.by(() => {
    if (view.label) lastLabel = view.label;
    return lastLabel;
  });
</script>

<svg class="defs" width="0" height="0" aria-hidden="true">
  <filter id="eve-mercury" x="-150%" y="-150%" width="400%" height="400%">
    <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" />
    <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16 -6" />
  </filter>
</svg>

<div
  class="eve-pill"
  data-phase={view.phase}
  data-open={view.isOpen}
  data-alert={view.isAlert}
  style:--left={left}
  style:--right={right}
  style:--middle={middle}
>
  {#if view.phase === 'done'}
    <svg class="check" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 6.4 4.8 9.2 10 3.4" pathLength="1" />
    </svg>
  {:else}
    <div class="mercury" aria-hidden="true">
      <span class="lobe lobe-left"></span>
      <span class="lobe lobe-middle"></span>
      <span class="lobe lobe-right"></span>
    </div>
  {/if}

  <div class="label-slot">
    <p class="label">
      {#if view.tag}<span class="tag">{view.tag}</span>{/if}{label}
    </p>
  </div>
</div>

<style>
  .defs {
    position: absolute;
  }

  .eve-pill {
    display: flex;
    align-items: center;
    height: 22px;
    padding: 0 6px;
    border: 1px solid rgb(255 255 255 / 0.22);
    border-radius: 999px;
    /* Stays readable (7.4:1) for white text even over a pure white window. */
    background: rgb(12 12 14 / 0.7);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.1), 0 2px 10px rgb(0 0 0 / 0.22);
    transition:
      height 240ms cubic-bezier(0.3, 1.4, 0.5, 1),
      padding 240ms cubic-bezier(0.3, 1.4, 0.5, 1),
      border-color 160ms ease-out;
  }

  .eve-pill[data-open='true'] {
    height: 30px;
    padding: 0 13px 0 11px;
  }

  .eve-pill[data-alert='true'] {
    border-color: rgb(248 113 113 / 0.55);
  }

  .mercury {
    position: relative;
    flex: none;
    width: 8px;
    height: 8px;
    filter: url(#eve-mercury);
    transition: width 90ms linear;
  }

  .eve-pill[data-open='true'] .mercury {
    width: calc(8px + (var(--left) + var(--right)) * 9px);
  }

  .eve-pill[data-phase='starting'] .mercury,
  .eve-pill[data-phase='working'] .mercury {
    width: 22px;
  }

  .lobe {
    position: absolute;
    top: 0;
    left: calc(50% - 4px);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f4f4f5;
    transition: transform 90ms linear, background-color 160ms ease-out;
  }

  .eve-pill[data-alert='true'] .lobe {
    background: #f87171;
  }

  .lobe-left {
    transform: translateX(calc(var(--left) * -9px)) scale(calc(1 - var(--left) * 0.2));
  }

  .lobe-right {
    transform: translateX(calc(var(--right) * 9px)) scale(calc(1 - var(--right) * 0.2));
  }

  .lobe-middle {
    transform: scale(calc(1 + var(--middle) * 0.3));
  }

  /* A silent microphone is still live: the dot keeps breathing. */
  .eve-pill[data-phase='live'][data-open='false'] .lobe-middle {
    animation: breathe 2400ms ease-in-out infinite;
  }

  .eve-pill[data-phase='starting'] .lobe-left { animation: part-left 1100ms ease-in-out infinite; }
  .eve-pill[data-phase='starting'] .lobe-right { animation: part-right 1100ms ease-in-out infinite; }

  .eve-pill[data-phase='working'] .lobe { animation: cross 1300ms cubic-bezier(0.45, 0, 0.55, 1) infinite; }
  .eve-pill[data-phase='working'] .lobe-middle { animation-delay: -433ms; }
  .eve-pill[data-phase='working'] .lobe-right { animation-delay: -866ms; }

  @keyframes breathe {
    0%, 100% { transform: scale(0.8); }
    50% { transform: scale(1.1); }
  }

  @keyframes part-left {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(-8px) scale(0.75); }
  }

  @keyframes part-right {
    0%, 100% { transform: translateX(0); }
    50% { transform: translateX(8px) scale(0.75); }
  }

  @keyframes cross {
    0% { transform: translateX(-11px) scale(0.45); }
    50% { transform: translateX(0) scale(1); }
    100% { transform: translateX(11px) scale(0.45); }
  }

  .check {
    flex: none;
    width: 12px;
    height: 12px;
  }

  .check path {
    fill: none;
    stroke: #f4f4f5;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1;
    animation: draw 220ms ease-out both;
  }

  @keyframes draw {
    from { stroke-dashoffset: 1; }
    to { stroke-dashoffset: 0; }
  }

  .label-slot {
    display: grid;
    grid-template-columns: 0fr;
    transition: grid-template-columns 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .eve-pill[data-open='true'] .label-slot {
    grid-template-columns: 1fr;
  }

  .label {
    min-width: 0;
    max-width: 200px;
    overflow: hidden;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 16px;
    color: #fff;
    text-overflow: ellipsis;
    /* Separates the label from any text showing through the glass. */
    text-shadow: 0 0 3px rgb(0 0 0 / 0.75);
    white-space: nowrap;
    opacity: 0;
    transition: opacity 120ms ease-out, padding-left 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .eve-pill[data-open='true'] .label {
    padding-left: 8px;
    opacity: 1;
  }

  .tag {
    margin-right: 6px;
    font-weight: 500;
    opacity: 0.8;
  }

  @media (prefers-reduced-motion: reduce) {
    .lobe {
      transform: none !important;
    }

    .mercury {
      width: 8px !important;
    }
  }

  @media (forced-colors: active) {
    .eve-pill {
      border-color: CanvasText;
      box-shadow: none;
    }

    .lobe {
      forced-color-adjust: none;
      background: CanvasText !important;
    }

    .check path {
      stroke: CanvasText;
    }
  }
</style>
