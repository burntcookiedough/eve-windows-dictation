export const HOTWORDS_WARNING_THRESHOLD = 50;

const SEPARATOR_REGEX = /[,\n;]+/;

export function parseHotwordsCsl(value: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];

  for (const raw of value.split(SEPARATOR_REGEX)) {
    const term = raw.trim();
    if (!term) {
      continue;
    }

    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push(term);
  }

  return entries;
}

export function formatHotwordsCsl(entries: string[]): string {
  return entries.join(', ');
}

export function buildHotwordsPrompt(value: string): string | undefined {
  const entries = parseHotwordsCsl(value);
  if (entries.length === 0) {
    return undefined;
  }
  return formatHotwordsCsl(entries);
}
