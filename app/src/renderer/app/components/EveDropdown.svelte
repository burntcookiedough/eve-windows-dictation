<script lang="ts">
  import { onMount } from 'svelte';
  import {
    calculateDropdownPosition,
    findFirstEnabledIndex,
    findLastEnabledIndex,
    findNextEnabledIndex,
    findTypeaheadIndex,
  } from './eve-dropdown';

  export interface EveDropdownOption {
    value: string;
    label: string;
    disabled?: boolean;
    description?: string;
  }

  interface Props {
    label: string;
    value: string;
    options: EveDropdownOption[];
    onchange: (value: string) => void;
    disabled?: boolean;
    id?: string;
    class?: string;
  }

  let {
    label,
    value,
    options,
    onchange,
    disabled = false,
    id,
    class: className = '',
  }: Props = $props();

  const componentId = $props.id();
  let buttonId = $derived(id ?? `eve-dropdown-${componentId}`);
  let listboxId = $derived(`${buttonId}-listbox`);

  let root: HTMLDivElement | undefined = $state(undefined);
  let button: HTMLButtonElement | undefined = $state(undefined);
  let open = $state(false);
  let activeIndex = $state(-1);
  let typeahead = $state('');
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined = $state(undefined);
  let listboxStyle = $state('top: 8px; left: 8px; width: 176px; max-height: 280px;');

  let selectedIndex = $derived(options.findIndex((option) => option.value === value));
  let selectedOption = $derived(options[selectedIndex] ?? options.find((option) => !option.disabled));
  let activeOptionId = $derived(activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined);

  function clearTypeahead(): void {
    typeahead = '';
    if (typeaheadTimer) clearTimeout(typeaheadTimer);
    typeaheadTimer = undefined;
  }

  function queueTypeaheadReset(): void {
    if (typeaheadTimer) clearTimeout(typeaheadTimer);
    typeaheadTimer = setTimeout(clearTypeahead, 700);
  }

  function setActive(index: number): void {
    if (index >= 0) activeIndex = index;
  }

  function positionListbox(): void {
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const position = calculateDropdownPosition({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      optionCount: options.length,
    });
    listboxStyle = `top: ${position.top}px; left: ${position.left}px; width: ${position.width}px; max-height: ${position.maxHeight}px;`;
  }

  function close(restoreFocus = false): void {
    open = false;
    clearTypeahead();
    if (restoreFocus) {
      queueMicrotask(() => button?.focus({ preventScroll: true }));
    }
  }

  function openMenu(index = selectedIndex): void {
    if (disabled || options.length === 0) return;
    const nextIndex = index >= 0 && !options[index]?.disabled ? index : findFirstEnabledIndex(options);
    if (nextIndex < 0) return;
    activeIndex = nextIndex;
    open = true;
    queueMicrotask(positionListbox);
  }

  function choose(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    onchange(option.value);
    close(true);
  }

  function move(direction: 1 | -1): void {
    const nextIndex = findNextEnabledIndex(options, activeIndex >= 0 ? activeIndex : selectedIndex, direction);
    setActive(nextIndex);
  }

  function typeaheadKey(key: string): void {
    const nextQuery = `${typeahead}${key}`;
    const nextIndex = findTypeaheadIndex(options, nextQuery, activeIndex >= 0 ? activeIndex : selectedIndex);
    typeahead = nextIndex >= 0 ? nextQuery : key;
    if (nextIndex >= 0) {
      setActive(nextIndex);
      if (!open) openMenu(nextIndex);
    }
    queueTypeaheadReset();
  }

  function handleButtonKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      if (open) close();
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      event.preventDefault();
      typeaheadKey(event.key);
      return;
    }

    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) openMenu(findFirstEnabledIndex(options));
      else move(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openMenu(findLastEnabledIndex(options));
      else move(-1);
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const targetIndex = event.key === 'Home' ? findFirstEnabledIndex(options) : findLastEnabledIndex(options);
      if (!open) openMenu(targetIndex);
      else setActive(targetIndex);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (!open) openMenu();
      else choose(activeIndex);
    }
  }

  function handleOptionClick(index: number): void {
    choose(index);
  }

  $effect(() => {
    if (!open) return;
    queueMicrotask(positionListbox);
    const handleViewportChange = () => positionListbox();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  });

  $effect(() => {
    if (!open) {
      activeIndex = selectedIndex >= 0 ? selectedIndex : findFirstEnabledIndex(options);
    } else if (activeIndex < 0 || options[activeIndex]?.disabled) {
      activeIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : findFirstEnabledIndex(options);
    }
  });

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (open && root && !root.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      clearTypeahead();
    };
  });
</script>

<div bind:this={root} data-eve-dropdown class="dropdown-root {className}">
  <button
    bind:this={button}
    id={buttonId}
    type="button"
    role="combobox"
    aria-label={label}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-activedescendant={open ? activeOptionId : undefined}
    {disabled}
    class="dropdown-trigger"
    onclick={() => open ? close() : openMenu()}
    onkeydown={handleButtonKeydown}
  >
    <span class="dropdown-value">{selectedOption?.label ?? 'Choose an option'}</span>
    <svg viewBox="0 0 12 12" class="dropdown-chevron" aria-hidden="true">
      <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if open}
    <div
      id={listboxId}
      role="listbox"
      aria-label={label}
      aria-labelledby={buttonId}
      class="dropdown-listbox"
      style={listboxStyle}
    >
      {#each options as option, index}
        <button
          id={`${listboxId}-option-${index}`}
          type="button"
          role="option"
          tabindex="-1"
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          aria-describedby={option.description ? `${listboxId}-option-${index}-description` : undefined}
          disabled={option.disabled}
          class="dropdown-option {option.value === value ? 'selected' : ''} {index === activeIndex ? 'active' : ''}"
          onclick={() => handleOptionClick(index)}
        >
          <span class="min-w-0 truncate">{option.label}</span>
          {#if option.description}<span id={`${listboxId}-option-${index}-description`} class="sr-only">{option.description}</span>{/if}
          {#if option.value === value}<span aria-hidden="true" class="dropdown-check"></span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dropdown-root {
    position: relative;
    min-width: 0;
    max-width: 100%;
  }

  .dropdown-trigger {
    display: inline-flex;
    max-width: 100%;
    min-height: 44px;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--fg2, #9b9b9b);
    font-size: 13px;
    line-height: normal;
    text-align: right;
    cursor: pointer;
    transition: color 200ms ease;
  }

  .dropdown-trigger:hover:not(:disabled),
  .dropdown-trigger[aria-expanded="true"] {
    color: var(--fg, #ececec);
  }

  .dropdown-root .dropdown-trigger:focus-visible {
    outline: none;
    box-shadow: 0 1px 0 var(--fg2, #9b9b9b);
    color: var(--fg, #ececec);
  }

  .dropdown-option:focus-visible {
    outline: 1px solid var(--fg, #ececec);
    outline-offset: 3px;
  }

  @media (forced-colors: active) {
    .dropdown-root .dropdown-trigger:focus-visible {
      outline: 1px solid Highlight;
      outline-offset: 3px;
      box-shadow: none;
    }
  }

  .dropdown-trigger:disabled,
  .dropdown-option:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .dropdown-value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dropdown-chevron {
    width: 12px;
    height: 12px;
    flex: none;
    color: var(--fg3, #565656);
    transition: transform 300ms var(--ease, cubic-bezier(.2, .7, .2, 1));
  }

  .dropdown-trigger[aria-expanded="true"] .dropdown-chevron {
    transform: rotate(180deg);
  }

  .dropdown-listbox {
    position: fixed;
    z-index: 60;
    overflow-x: hidden;
    overflow-y: auto;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.14));
    padding: 4px;
    background: var(--bg, #0b0b0b);
    color: var(--fg2, #9b9b9b);
    box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.55);
  }

  .dropdown-option {
    display: flex;
    width: 100%;
    min-width: 0;
    min-height: 34px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 0;
    padding: 8px 10px;
    background: transparent;
    color: var(--fg2, #9b9b9b);
    text-align: left;
    cursor: pointer;
    transition: color 180ms ease, background 180ms ease;
  }

  .dropdown-option:hover,
  .dropdown-option.active {
    background: var(--hover, rgba(255, 255, 255, 0.028));
    color: var(--fg, #ececec);
  }

  .dropdown-option.selected {
    color: var(--fg, #ececec);
  }

  .dropdown-check {
    width: 5px;
    height: 5px;
    flex: none;
    border-radius: 50%;
    background: currentColor;
  }

  @media (prefers-reduced-motion: reduce) {
    .dropdown-trigger,
    .dropdown-chevron,
    .dropdown-option {
      transition-duration: 1ms;
    }
  }
</style>
