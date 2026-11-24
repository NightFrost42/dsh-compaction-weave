// Thin facade preserving the 12 public exports of the layered audit engine.
// Zero LLM calls; operates on summaryProse() so verbatim Section 6 cannot mask prose reversals.

export {
  coverageOf,
  negationsOf,
  stripExplicitValueCorrection,
} from './audit/normalize.js';
export { scalarRequirement } from './audit/numeric.js';
export {
  conditionParts,
  extractConstraintLines,
  sourceConstraintEvidence,
  sourceEvidenceSentences,
  sourceEvidenceSentencesLegacyQuoteSplit,
} from './audit/clauses.js';
export { auditCompaction } from './audit/compaction.js';
export {
  auditInstructionProvenance,
  summarizeProvenanceFailures,
} from './audit/provenance.js';
