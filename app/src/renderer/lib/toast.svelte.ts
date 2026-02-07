export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

class ToastState {
  toasts = $state<Toast[]>([]);

  add(message: string, type: ToastType = 'success', duration = 2000) {
    const id = crypto.randomUUID();
    this.toasts.push({ id, message, type });

    setTimeout(() => {
      this.remove(id);
    }, duration);
  }

  remove(id: string) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }
}

export const toastState = new ToastState();

// Convenience function for easy imports
export function toast(message: string, type: ToastType = 'success', duration = 2000) {
  toastState.add(message, type, duration);
}
