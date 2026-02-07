# Metrics Research Guide (Template)

Date: 2026-02-07
Status: Draft template (no research filled yet)

## Purpose

Use this file as a structured starting point for future research on transcription quality and product metrics for Murmur.

## Research Questions

- Which metrics best reflect user-perceived transcription quality?
- Which metrics are practical to compute continuously in development?
- Which metrics are safe and cheap enough for optional production telemetry?

## Candidate Metric Categories

### 1) Global transcript quality

- WER
- CER
- MER / WIL / WIP

Notes to fill later:
- Definition:
- Pros:
- Cons:
- Needed data:
- Reference links:

### 2) Domain-term performance

- Term Recall@Exact
- Term Precision (false insertions)
- Confusable-pair error rate

Notes to fill later:
- Definition:
- Pros:
- Cons:
- Needed data:
- Reference links:

### 3) Runtime and UX performance

- Partial latency (P50/P95)
- Final latency (P50/P95)
- Time-to-first-partial
- Session timeout behavior quality

Notes to fill later:
- Definition:
- Pros:
- Cons:
- Needed data:
- Reference links:

### 4) Stability and safety

- Hallucination rate (silent or low-speech segments)
- Partial-to-final churn rate
- Hotword false-positive rate

Notes to fill later:
- Definition:
- Pros:
- Cons:
- Needed data:
- Reference links:

## Evaluation Dataset Plan (To Be Researched)

- In-domain curated set (target terms + negatives)
- General regression set
- Multilingual slices if needed

Questions to answer later:
- Minimum sample sizes for confidence
- Labeling process and quality checks
- Storage format and reproducibility

## Instrumentation Plan (To Be Designed)

- What can be measured in server logs now
- What requires protocol additions
- What should remain local-only

## Reporting Format (To Be Designed)

- Weekly metric snapshot
- Change-impact report for each feature
- Threshold-based regression alerts

## Decision Log

- Keep a short dated log of metric decisions here.

Example:
- YYYY-MM-DD: Chosen primary metric = ... because ...
