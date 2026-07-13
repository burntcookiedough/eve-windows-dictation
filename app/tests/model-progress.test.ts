import { describe, expect, test } from 'bun:test';
import {
  formatProgressBytes,
  formatProgressDuration,
  getModelProgressShortSummary,
  getModelProgressView,
  shouldShowModelProgress,
} from '../src/shared/model-progress';

describe('model progress presentation', () => {
  test('formats download metrics and ETA', () => {
    const view = getModelProgressView({
      model: 'large-v3-turbo',
      size_gb: 1.5,
      status: 'downloading',
      phase: 'downloading',
      progress_percent: 74.4,
      downloaded_bytes: 1_200_000_000,
      total_bytes: 1_621_666_023,
      bytes_per_second: 1_250_000,
      eta_seconds: 338,
      current_file: 'model weights',
    });

    expect(view?.stepLabel).toBe('Step 2 of 3');
    expect(view?.summary).toContain('model weights');
    expect(view?.metrics).toContain('74%');
    expect(view?.metrics).toContain('About 6 min remaining');
    expect(getModelProgressShortSummary({
      model: 'large-v3-turbo',
      size_gb: 1.5,
      status: 'downloading',
      phase: 'downloading',
      progress_percent: 74.4,
      eta_seconds: 338,
    })).toBe('Downloading speech model — 74%, about 6 min remaining.');
  });

  test('uses an indeterminate summary until throughput is known', () => {
    const state = {
      model: 'tiny',
      size_gb: 0.07,
      status: 'downloading' as const,
      phase: 'downloading' as const,
    };
    const view = getModelProgressView(state);

    expect(view?.progressPercent).toBeNull();
    expect(view?.metrics).toBe('Estimating time remaining…');
    expect(getModelProgressShortSummary(state)).toBe(
      'Downloading speech model — estimating time remaining.'
    );
  });

  test('renders the cache-checking stage distinctly', () => {
    const state = {
      model: 'large-v3-turbo',
      size_gb: 1.5,
      status: 'missing' as const,
      phase: 'checking' as const,
    };

    const view = getModelProgressView(state);
    expect(view?.stepLabel).toBe('Step 1 of 3');
    expect(view?.metrics).toBeNull();
    expect(getModelProgressShortSummary(state)).toBe('Checking speech model files.');
    expect(shouldShowModelProgress(state)).toBeTrue();
  });

  test('separates loading from network ETA', () => {
    const view = getModelProgressView({
      model: 'large-v3-turbo',
      size_gb: 1.5,
      status: 'ready',
      phase: 'loading',
      progress_percent: 100,
    });

    expect(view?.stepLabel).toBe('Step 3 of 3');
    expect(view?.summary).toContain('Loading the speech model into memory');
    expect(view?.metrics).not.toContain('remaining');
  });

  test('does not render a progress card after readiness', () => {
    expect(getModelProgressView({
      model: 'tiny',
      size_gb: 0.07,
      status: 'ready',
      phase: 'ready',
    })).toBeNull();
  });

  test('formats byte and duration boundaries', () => {
    expect(formatProgressBytes(1024 ** 3)).toBe('1.00 GB');
    expect(formatProgressDuration(59)).toBe('less than a minute');
    expect(formatProgressDuration(3660)).toBe('1 hr 1 min');
  });
});
