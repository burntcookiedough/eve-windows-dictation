import type { ServerSettingOption } from '../../shared/types.js';

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
