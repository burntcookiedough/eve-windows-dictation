<script lang="ts">
  interface Props {
    levels: number[];
    width?: number;      // Total width in px (default: auto)
    height?: number;     // Height in px (default: 30)
    barWidth?: number;   // Bar width in px (default: 3)
    gap?: number;        // Gap between bars in px (default: 2)
    color?: string;      // Bar color or gradient (default: white gradient)
    minHeight?: number;  // Minimum bar height as fraction 0-1 (default: 0.06)
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

<div class="flex items-center justify-center px-2" style={containerStyle} style:gap="{gap}px">
  {#each displayLevels as level}
    <div
      class="shrink-0 min-h-[2px] bg-gradient-to-t from-zinc-300/60 to-zinc-100/90"
      style="{barStyle} height: {level * height}px;"
    ></div>
  {/each}
</div>
