<script lang="ts">
  interface Props {
    text: string;
    isFinal: boolean;
  }

  let { text, isFinal }: Props = $props();
</script>

<div class="text-display" class:final={isFinal}>
  <p>{text}</p>
</div>

<style>
  .text-display {
    max-width: 350px;
    padding: 12px 20px;
    background: rgba(26, 26, 26, 0.95);
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    transition: opacity 100ms ease;
  }

  .text-display.final {
    background: rgba(26, 26, 26, 0.98);
    box-shadow: 0 4px 24px rgba(34, 197, 94, 0.2);
  }

  p {
    color: #ffffff;
    font-size: 16px;
    font-weight: 500;
    line-height: 1.4;
    text-align: center;
    margin: 0;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .text-display.final p {
    color: #22c55e;
  }
</style>
