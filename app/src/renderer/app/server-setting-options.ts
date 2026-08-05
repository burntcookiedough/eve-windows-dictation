import type { ServerSettingOption } from '../../shared/types.js';

export function disabledOptionReasons(options: Array<ServerSettingOption<unknown>>): string[] {
  return options.flatMap((option) =>
    option.disabled && option.reason ? [`${option.label}: ${option.reason}`] : [],
  );
}

export function optionsForDraftWhisperDevice(
  options: Array<ServerSettingOption<unknown>>,
  whisperDevice: string,
): Array<ServerSettingOption<unknown>> {
  return options.map((option) => {
    const state = option.device_compatibility?.[whisperDevice];
    return state
      ? { ...option, disabled: state.disabled, reason: state.reason ?? undefined }
      : option;
  });
}
