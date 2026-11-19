# Archived Overfitted Regex & Fixture Suites

These 21 test suites and `fixtures/` were archived during the Route B refactor (`instruction-source.js`, `progress-facts.js`, `progress-state.js`, `action-state.js`, `audit.js`, `memory-policy.js`). (`audit-corpus.json` remains active at `test/audit-corpus.json` for `test/integration/independent.mjs`.)

Why archived:
- They were coupled to domain-specific regex dictionaries (`报告 / 图表 / 扫描 / 离线包 / 打包`, `reportGenerated / chartGenerated / scanCompleted / packageCompleted`, `review.35`, `绘制地图`, `任务甲乙丙丁`, `顺手写库`) and natural-language quotation/adoption guessing rules.
- Route B replaces those heuristics with host event provenance (`sourceKind` / `role`), explicit `<verified_user_message>` vs `<untrusted_reference>` XML channels, structured `key: value` progress checks, and deterministic source-hash/structure/coverage/polarity guards.

Active tests remain in `test/*.mjs` (42 suites) plus `test/integration/*.mjs`.
