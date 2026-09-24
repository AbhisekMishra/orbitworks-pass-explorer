/**
 * Summary statistics of a pass list. Shared so the API (which returns them) and the web app
 * (which recomputes them when satellites are toggled, without asking the API again) agree exactly.
 */
import { MS_PER_SECOND } from './constants.js';
import type { AccessStats, Pass } from './schemas.js';

/**
 * @param passes chronological (by start), as the API returns them.
 * @param satellites every satellite asked about: each gets a count, even with no pass.
 */
export function computePassStats(passes: readonly Pass[], satellites: readonly string[]): AccessStats {
  const bySatellite = Object.fromEntries(satellites.map((s) => [s, 0]));
  for (const p of passes) bySatellite[p.satellite] = (bySatellite[p.satellite] ?? 0) + 1;

  let meanRevisitS: number | null = null;
  let maxGapS: number | null = null;
  const [firstPass, ...rest] = passes;
  const lastPass = passes.at(-1);
  if (firstPass && lastPass && rest.length > 0) {
    meanRevisitS = Math.round(
      (Date.parse(lastPass.start) - Date.parse(firstPass.start)) / MS_PER_SECOND / rest.length,
    );
    // Longest period with no satellite inside the circle (passes of different satellites overlap).
    let coveredUntil = Date.parse(firstPass.end);
    let gap = 0;
    for (const p of rest) {
      gap = Math.max(gap, Date.parse(p.start) - coveredUntil);
      coveredUntil = Math.max(coveredUntil, Date.parse(p.end));
    }
    maxGapS = gap / MS_PER_SECOND;
  }
  return {
    passCount: passes.length,
    totalDurationS: passes.reduce((sum, p) => sum + p.durationS, 0),
    bySatellite,
    meanRevisitS,
    maxGapS,
  };
}
