import './app.css';
import App from './App.svelte';
import { mount, unmount } from 'svelte';

declare global {
  interface Window {
    __eveRendererFailed?: boolean;
  }
}

let app: ReturnType<typeof mount> | undefined;
let rendererMounted = false;
let recoveryInProgress = false;

async function showRendererRecovery(error: unknown): Promise<void> {
  if (recoveryInProgress) return;
  recoveryInProgress = true;
  window.__eveRendererFailed = true;
  console.error('Eve renderer failed and entered recovery mode', error);

  const target = document.getElementById('app');
  if (!target || target.querySelector('[data-renderer-recovery]')) return;
  if (app) {
    const mountedApp = app;
    app = undefined;
    try {
      await unmount(mountedApp);
    } catch (unmountError) {
      console.error('Eve renderer cleanup failed during recovery', unmountError);
    }
  }
  target.replaceChildren();

  const recovery = document.createElement('main');
  recovery.dataset.rendererRecovery = '';
  recovery.className = 'flex h-full items-center justify-center bg-[#08090a] p-6 text-zinc-100';
  recovery.style.cssText = 'display:flex;height:100%;align-items:center;justify-content:center;background:#08090a;padding:24px;color:#f4f4f5;';
  recovery.innerHTML = `
    <section class="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
      <p class="text-xs font-medium uppercase tracking-[0.16em] text-zinc-500">Eve</p>
      <h1 class="mt-3 text-xl font-semibold text-zinc-50">The window needs a refresh</h1>
      <p class="mt-2 text-sm leading-6 text-zinc-400">Your settings and recordings are safe. Reload Eve's interface to continue.</p>
      <button data-renderer-reload type="button" class="mt-5 min-h-10 cursor-pointer rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-100">Reload interface</button>
    </section>`;
  recovery.querySelector<HTMLButtonElement>('[data-renderer-reload]')?.addEventListener('click', () => location.reload());
  target.append(recovery);
}

window.addEventListener('error', (event) => {
  if (!rendererMounted) {
    void showRendererRecovery(event.error ?? event.message);
    return;
  }
  console.error('Eve renderer runtime error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  // An async IPC or device request may reject without invalidating the mounted UI.
  // Keep the window usable; individual features own their retry/error presentation.
  console.error('Eve renderer async operation rejected', event.reason);
});

try {
  app = mount(App, {
    target: document.getElementById('app')!,
  });
  rendererMounted = true;
} catch (error) {
  void showRendererRecovery(error);
}

export default app;
