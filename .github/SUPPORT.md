# Support

Eve is currently maintained as an engineering project, not a staffed support service. There is no guaranteed response time.

Before reporting a problem:

1. Confirm the exact release version and whether the app is using the packaged local service or an external server.
2. Read [the build guide](../docs/development/building.md) for development and packaging failures.
3. Use the app's bounded diagnostics summary where available. Review it before sharing.
4. Remove transcript text, clipboard contents, device labels, tokens, usernames, and full local paths.

Public issue tracking is currently closed. Source fixes can be proposed with a focused draft pull request. Security-sensitive reports must use the private process in [SECURITY.md](SECURITY.md), not a public pull request.

The public v0.7.0 Eve release keeps the frozen internal Murmur-compatible install chain while using `%APPDATA%\Eve` as its active profile. The legacy `%APPDATA%\murmur` profile is preserved, never automatically imported or inspected, and must not be renamed or moved manually. v0.8 remains unreleased.
