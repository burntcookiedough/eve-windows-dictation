# Support

Eve is currently maintained as an engineering project, not a staffed support service. There is no guaranteed response time.

Before reporting a problem:

1. Confirm the exact release version and whether the app is using the packaged local service or a separately started localhost development service.
2. Read [the build guide](../docs/development/building.md) for development and packaging failures.
3. Use the app's bounded diagnostics summary where available. Review it before sharing.
4. Remove transcript text, clipboard contents, device labels, tokens, usernames, and full local paths.

Report bugs and problems through GitHub Issues. Source fixes can be proposed with a focused pull request targeting `trunk`. Security-sensitive reports must use the private process in [SECURITY.md](SECURITY.md), not public issues or pull requests.

Eve releases keep the frozen internal Murmur-compatible install chain while using `%APPDATA%\Eve` as the active profile. The legacy `%APPDATA%\murmur` profile is preserved, never automatically imported or inspected, and must not be renamed or moved manually. Published pre-releases, including v0.8.2-alpha.8, are available on [GitHub Releases](https://github.com/burntcookiedough/eve-windows-dictation/releases).
