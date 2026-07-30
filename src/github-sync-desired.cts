'use strict';
/**
 * Authoritative local desired-state projection for github-sync. Planning files
 * are read here, once, and callers receive a JSON-safe result rather than raw
 * Markdown/YAML parser output or filesystem errors.
 */

import fs from 'node:fs';
import path from 'node:path';

const DESIRED_REASON = Object.freeze({
  OK: 'ok',
  LOCAL_UNAVAILABLE: 'local_unavailable',
} as const);

type DesiredReason = typeof DESIRED_REASON[keyof typeof DESIRED_REASON];

interface DesiredPhase {
  id: string;
  title: string;
  goal: string;
}

interface DesiredPlan {
  id: string;
  phaseId: string;
  wave: number | null;
  autonomous: boolean;
  requirements: string[];
  complete: boolean;
}

interface DesiredState {
  available: boolean;
  reason: DesiredReason;
  phases: DesiredPhase[];
  plans: DesiredPlan[];
  currentPhase: string | null;
}

function unavailable(): DesiredState {
  return { available: false, reason: DESIRED_REASON.LOCAL_UNAVAILABLE, phases: [], plans: [], currentPhase: null };
}

function normalizeId(value: string): string {
  return value.padStart(2, '0');
}

function parseRoadmap(raw: string): DesiredPhase[] | null {
  const matches = [...raw.matchAll(/^### Phase (\d+(?:\.\d+)?):\s*(.+)$/gm)];
  if (matches.length === 0) return null;
  const phases: DesiredPhase[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextOffset = matches[index + 1]?.index ?? raw.length;
    const section = raw.slice(match.index! + match[0].length, nextOffset);
    const goal = /^\*\*Goal\*\*:\s*(.+)$/m.exec(section)?.[1]?.trim() ?? '';
    phases.push({ id: normalizeId(match[1]), title: match[2].trim(), goal });
  }
  return phases.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function parseCurrentPhase(raw: string): string | null {
  const match = /^current_phase:\s*['\"]?(\d+(?:\.\d+)?)['\"]?\s*$/m.exec(raw);
  return match ? normalizeId(match[1]) : null;
}

function parsePlanMetadata(raw: string): Pick<DesiredPlan, 'wave' | 'autonomous' | 'requirements'> | null {
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw)?.[1];
  if (!frontmatter) return null;
  const waveMatch = /^wave:\s*(\d+)\s*$/m.exec(frontmatter);
  const autonomousMatch = /^autonomous:\s*(true|false)\s*$/m.exec(frontmatter);
  const requirementsMatch = /^requirements:\s*\[([^\]]*)\]\s*$/m.exec(frontmatter);
  return {
    wave: waveMatch ? Number(waveMatch[1]) : null,
    autonomous: autonomousMatch?.[1] === 'true',
    requirements: requirementsMatch?.[1].split(',').map((item) => item.trim()).filter(Boolean) ?? [],
  };
}

function readPlans(planningDir: string): DesiredPlan[] | null {
  const phaseRoot = path.join(planningDir, 'phases');
  let phaseDirs: string[];
  try { phaseDirs = fs.readdirSync(phaseRoot); } catch { return []; }
  const plans: DesiredPlan[] = [];
  for (const phaseDir of phaseDirs.sort()) {
    const directory = path.join(phaseRoot, phaseDir);
    let entries: string[];
    try { entries = fs.readdirSync(directory); } catch { return null; }
    for (const entry of entries.sort()) {
      const match = /^(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/.exec(entry);
      if (!match) continue;
      let metadata: Pick<DesiredPlan, 'wave' | 'autonomous' | 'requirements'> | null;
      try { metadata = parsePlanMetadata(fs.readFileSync(path.join(directory, entry), 'utf8')); } catch { return null; }
      if (!metadata) return null;
      const id = `${normalizeId(match[1])}-${match[2]}`;
      plans.push({ ...metadata, id, phaseId: normalizeId(match[1]), complete: fs.existsSync(path.join(directory, `${match[1]}-${match[2]}-SUMMARY.md`)) });
    }
  }
  return plans.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function readDesiredState(cwd: string): DesiredState {
  try {
    const planningDir = path.join(cwd, '.planning');
    const phases = parseRoadmap(fs.readFileSync(path.join(planningDir, 'ROADMAP.md'), 'utf8'));
    const currentPhase = parseCurrentPhase(fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf8'));
    const plans = readPlans(planningDir);
    if (!phases || !currentPhase || !plans) return unavailable();
    return { available: true, reason: DESIRED_REASON.OK, phases, plans, currentPhase };
  } catch {
    return unavailable();
  }
}

export = { readDesiredState, DESIRED_REASON };
