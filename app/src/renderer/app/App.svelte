<script lang="ts">
  // Main window root component
  // This is the shell that will hold settings, history, and other features
</script>

<div class="main-container">
  <header class="header">
    <h1 class="title">Murmur</h1>
  </header>

  <main class="content">
    <div class="placeholder">
      <p class="placeholder-text">Settings, history, and more coming soon.</p>
      <p class="placeholder-hint">Press your hotkey to start transcribing.</p>
    </div>
  </main>
</div>

<style>
  .main-container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-background-secondary);
  }

  .title {
    font-size: 18px;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .content {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .placeholder {
    text-align: center;
  }

  .placeholder-text {
    font-size: 16px;
    color: var(--color-text-secondary);
    margin-bottom: 8px;
  }

  .placeholder-hint {
    font-size: 14px;
    color: var(--color-text-muted);
  }
</style>
