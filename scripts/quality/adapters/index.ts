/**
 * Analyzer registration.
 *
 * Adding an analyzer means adding one import and one `registerAnalyzer` call
 * here. Nothing else in the engine changes: baselines, gates, run records,
 * dispositioning, SARIF and CLI output are inherited. If a new analyzer requires
 * touching any file under lib/, the engine is wrong.
 */
import { registerAnalyzer } from '../lib/registry';
import { sourceIntegrityAnalyzer } from './sourceIntegrity';
import { maintainabilityAnalyzer } from './maintainability';
import { duplicationAnalyzer } from './duplication';
import { unusedStructureAnalyzer } from './unusedStructure';
import { architectureAnalyzer } from './architecture';

registerAnalyzer(sourceIntegrityAnalyzer);
registerAnalyzer(maintainabilityAnalyzer);
registerAnalyzer(duplicationAnalyzer);
registerAnalyzer(unusedStructureAnalyzer);
registerAnalyzer(architectureAnalyzer);

export {
  sourceIntegrityAnalyzer,
  maintainabilityAnalyzer,
  duplicationAnalyzer,
  unusedStructureAnalyzer,
  architectureAnalyzer,
};
