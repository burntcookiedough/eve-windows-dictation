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
      if (open && !root?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      clearTypeahead();
    };
  });
</script>

<div bind:this={root} data-eve-dropdown class="relative min-w-0 w-full max-w-full sm:w-auto {className}">
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
    class="flex min-h-9 min-w-0 w-full max-w-full items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-xs text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-32 sm:w-auto"
    onclick={() => open ? close() : openMenu()}
    onkeydown={handleButtonKeydown}
  >
    <span class="min-w-0 truncate">{selectedOption?.label ?? 'Choose an option'}</span>
    <svg viewBox="0 0 12 12" class="h-3 w-3 shrink-0 text-zinc-400" aria-hidden="true">
      <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  {#if open}
    <div
      id={listboxId}
      role="listbox"
      aria-label={label}
      aria-labelledby={buttonId}
      class="fixed z-50 overflow-x-hidden overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950 p-1 shadow-[0_16px_40px_rgba(0,0,0,0.55)] focus:outline-none"
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
          class="flex min-h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-100 disabled:cursor-not-allowed disabled:opacity-45 {option.value === value ? 'bg-white/[0.09] text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'} {index === activeIndex ? 'ring-1 ring-inset ring-zinc-300/70' : ''}"
          onclick={() => handleOptionClick(index)}
        >
          <span class="min-w-0 truncate">{option.label}</span>
          {#if option.description}<span id={`${listboxId}-option-${index}-description`} class="sr-only">{option.description}</span>{/if}
          {#if option.value === value}<span aria-hidden="true" class="shrink-0 text-zinc-200">✓</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
