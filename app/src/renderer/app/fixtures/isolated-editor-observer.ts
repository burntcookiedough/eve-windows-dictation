/** Explicit test-editor observation. Never attaches to other windows or reads a clipboard. */
export interface InsertionObservation {
  clockDomain: 'isolated_editor_performance_now';
  observedAt: number;
  eventType: 'input';
  charCount: number;
  inputType: string;
}
export class IsolatedEditorObserver {
  private latestObservation: InsertionObservation | null = null;
  private previousValue: string;
  private readonly listeners = new Set<(obs: InsertionObservation) => void>();
  private readonly handler = (event: Event): void => {
    const current = this.element.value;
    const changed = current !== this.previousValue;
    this.previousValue = current;
    const input = event as InputEvent;
    // Requests, script-dispatched events and deletions are not insertion proof.
    if (!input.isTrusted || !changed || !current || !input.inputType?.startsWith('insert')) return;
    const observation: InsertionObservation = {
      clockDomain: 'isolated_editor_performance_now', observedAt: performance.now(),
      eventType: 'input', charCount: current.length, inputType: input.inputType,
    };
    this.latestObservation = observation;
    for (const listener of this.listeners) listener({ ...observation });
  };
  constructor(private readonly element: HTMLTextAreaElement | HTMLInputElement) {
    this.previousValue = element.value;
    element.addEventListener('input', this.handler);
  }
  getObservation(): InsertionObservation | null {
    return this.latestObservation ? { ...this.latestObservation } : null;
  }
  onObservation(listener: (obs: InsertionObservation) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  reset(): void {
    this.latestObservation = null;
    this.element.value = '';
    this.previousValue = '';
  }
  dispose(): void {
    this.element.removeEventListener('input', this.handler);
    this.listeners.clear();
  }
}
declare global { interface Window { isolatedEditorObserver?: IsolatedEditorObserver; } }
if (typeof document !== 'undefined') {
  const editor = document.getElementById('isolated-editor') as HTMLTextAreaElement | null;
  if (editor) {
    const observer = new IsolatedEditorObserver(editor);
    window.isolatedEditorObserver = observer;
    observer.onObservation(obs => {
      const result = document.getElementById('observation-result');
      if (result) result.textContent = `Editor insertion observed: ${obs.inputType}, ${obs.charCount} characters, editor clock ${obs.observedAt.toFixed(2)} ms. Typing also inserts text; verify the trial's paste action separately.`;
    });
  }
}
