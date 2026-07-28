# Gate 5A design QA

Status: **Passed locally**

## Frozen targets

- Application:
  `docs/architecture/assets/eve-gate-5-application-reference.png`
  (`37A983FA4BA295347E4FEBB28DAB428570DFB997E27209A002BBF7E74806DC4C`)
- Overlay:
  `docs/architecture/assets/eve-gate-5-overlay-reference.png`
  (`60CC848D4837BB83307C9F750D1DD3D9F6D83B364707780A363E86D971EDF742`)

The 2026-07-27 user attachment was independently hashed and proved byte-for-byte
identical to the tracked application target. Placeholder copy, dates, settings, model
names, endpoints, and metrics in the references were not treated as product
requirements.

## Comparison method

The real production renderer build was loaded in Electron with synthetic history,
insights, settings, server, and overlay data. History, Insights, and Settings were
captured at 500 x 900, matching the approximate viewport of each reference panel.
The reference and all three implementation captures were placed into one comparison
image before review. Overlay Resting and Long states were captured at 900 x 320.

Local, untracked evidence is under:

`C:\Users\anshu\.codex\visualizations\2026\07\26\019f9fce-0278-7b60-9217-45c02dc1ba76\gate5a-implementation`

The comparison image is `eve-gate5a-application-comparison.png`. These generated
captures contain synthetic data only and are intentionally excluded from Git.

## Application result

| Surface | Result | Evidence |
|---|---|---|
| Shell | Passed | Compact native-caption-aware title area, centered segmented navigation, near-black background, subtle monochrome dividers, and no glow. |
| History | Passed | Search and filter affordance, date grouping, compact contiguous ledger rows, two-line transcript previews, always-visible copy/delete actions, timestamps, long-text containment, empty state, and keyboard row actions match the approved hierarchy. |
| Insights | Passed | Range control, stacked Dictation time/Dictations/Average length panels, real-data bar chart, activity-dot matrix, line chart, and labelled per-day table reproduce the approved information hierarchy. Existing words, performance, quality, and speaking-profile data remain below the reference-height fold rather than being deleted. |
| Settings | Passed | Compact contiguous rows, dividers, controls, section rhythm, and Advanced grouping match the target. Actual Eve settings replace mock placeholders. Existing Engine and Server operations remain under Settings > Advanced. |
| Lab/Server IA | Passed | Lab is development-only; no production Lab or Server tab exists; Server is preserved under Advanced. |

## Overlay result

| State | Result | Evidence |
|---|---|---|
| Resting | Passed | Fixed 150 x 50 monochrome waveform capsule, 3:1 ratio, no external glow. |
| Active | Passed | Real audio levels remain the sole waveform driver; monochrome bars retain the same capsule geometry and do not flash. |
| Split | Passed | Transcript separates upward from the waveform over 220 ms using the approved easing, settling with a 12 px gap. Reduced motion makes the change immediate. |
| Long transcript | Passed | Transcript height is fixed at 64 px and exactly two visible lines. New text auto-follows programmatically; no operable scrollbar or fake control is shown. |
| Input/accessibility boundary | Passed | Overlay remains mouse-through, non-focusable, `aria-hidden`, and never steals keyboard focus. The existing hotkey remains the only stop mechanism. |

## Measured checks

- Near-white `#F4F4F5` on `#08090A`: 18.13:1.
- Zinc `#D4D4D8` on `#08090A`: 13.48:1.
- Muted `#A1A1AA` on `#08090A`: 7.78:1.
- Muted `#A1A1AA` on opaque fallback `#18191B`: 6.86:1.
- All text combinations above exceed WCAG 2.2 AA; focus indication uses a
  high-contrast 2 px ring.
- Forced-colors capture preserved boundaries, names, actions, and visible focus.
- Reduced-motion and reduced-transparency emulation preserved layout and meaning.
- 100%, 125%, 150%, and 200% device-scale captures preserved hierarchy and actions.
- 200% text zoom reflowed without horizontal loss of the primary navigation, search,
  transcript row action, or grouped history structure.
- Keyboard order was linear: primary navigation, search, filter, transcript row,
  copy, delete, then the next row.
- Chromium's accessibility tree exposed `Eve` as the root, `Main navigation`, named
  History/Insights/Settings buttons, a named search textbox, and independent named
  transcript/copy/delete buttons.

## Deliberate target differences

- The current microphone application icon remains until separately authorized Gate
  5B. Gate 5A does not create or package the cactus resources.
- Reference settings values and server metadata are illustrative. Gate 5A preserves
  actual Eve settings and Server behavior.
- Native Windows caption buttons are outside Chromium page capture. Production uses
  Electron's native `titleBarOverlay`; the prior custom caption buttons were removed
  so minimize/maximize/close, Alt+Space, and Windows 11 Snap remain OS-owned.
- The implementation does not add Pause, End, Retry, hover controls, or manual
  transcript scrolling because those interactions are explicitly deferred.

## Mismatch disposition

- P0 blockers: none.
- P1 functional or accessibility mismatches: none.
- P2 visible target mismatches: none after compact-row, Insights-visual, and overlay
  spacing corrections.
- P3 polish: cactus icon/resource replacement belongs to Gate 5B and is not a Gate 5A
  defect.

final result: passed
