<script lang="ts">
  interface Props {
    levels: number[];
    width?: number;      // Total width in px (default: auto)
    height?: number;     // Height in px (default: 30)
    barWidth?: number;   // Bar width in px (default: 4)
    gap?: number;        // Gap between bars in px (default: 2)
    color?: string;      // Bar color or gradient (default: blue gradient)
    minHeight?: number;  // Minimum bar height as fraction 0-1 (default: 0.1)
  }

  let {
    levels,
    width,
    height = 30,
    barWidth = 3,
    gap = 2,
    color,
    minHeight = 0.06,
  }: Props = $props();

  // Ensure valid range and add minimum height
  const displayLevels = $derived(
    levels.map(level => Math.max(minHeight, Math.min(1, level)))
  );

  const containerStyle = $derived(
    width ? `width: ${width}px; height: ${height}px;` : `height: ${height}px;`
  );

  const barStyle = $derived(
    `width: ${barWidth}px; border-radius: ${barWidth / 2}px;` +
    (color ? ` background: ${color};` : '')
  );
</script>

<div class="waveform" style={containerStyle} style:gap="{gap}px">
  {#each displayLevels as level}
    <div
      class="bar"
      style="{barStyle} height: {level * height}px;"
    ></div>
  {/each}
</div>

<style>
  .waveform {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px;
  }

  .bar {
    background: linear-gradient(to top, #3b82f6, #60a5fa);
    min-height: 2px;
    flex-shrink: 0;
  }
</style>
