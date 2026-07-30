# Eve v0.7.0 release notes

Status: historical release notes. Eve v0.7.0 is public; its release assets and hashes
remain immutable.

## Highlights

- Eve is the visible Windows product name, executable, installer, shortcut, and
  AppUserModelID (`io.github.burntcookiedough.eve`).
- Eve uses its own fresh `%APPDATA%\Eve` profile. It does **not** automatically import,
  merge, prompt for, or delete Murmur History, settings, hotwords, browser storage,
  credentials, external-server configuration, or other personal state.
- The desktop app now uses the approved compact monochrome History, Insights, and
  Settings experience, with existing Server controls grouped under Settings > Advanced.
- The waveform overlay remains click-through and non-focusable, with a fixed two-line
  transcript viewport and programmatic newest-text follow rather than interactive
  controls or manual scrolling.
- Eve includes the original monochrome cactus Windows resource family for the application,
  title bar, taskbar, tray variants, Start menu, shortcuts, installer, and uninstaller.

## Compatibility and privacy

- The established NSIS upgrade/uninstall chain remains frozen through GUID
  `0204d005-75b3-5b31-b1f6-ef2831e2b204`.
- Existing `%APPDATA%\murmur` data remains untouched. Shared model caches remain outside
  the profile migration boundary.
- The internal `murmur` package name, payload compatibility name, `MURMUR_*` interfaces,
  preload bridges, and local protocol remain unchanged for compatibility.

## Historical publication notes

Eve v0.7.0 was published after its separately approved release procedure. The release was
unsigned: Windows may show an Unknown Publisher warning and Microsoft Defender SmartScreen
may require an explicit user decision before installation. The accepted Eve name/mark risk
was not legal clearance.
