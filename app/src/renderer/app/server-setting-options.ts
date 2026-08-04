import type { ServerSettingOption } from '../../shared/types.js';

export function disabledOptionReasons(options: Array<ServerSettingOption<unknown>>): string[] {
  return options.flatMap((option) =>
    option.disabled && option.reason ? [`${option.label}: ${option.reason}`] : [],
  );
}
