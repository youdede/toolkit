#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  process.stderr.write('usage: validate-exercise-plan.mjs <plan.json>\n');
  process.exit(2);
}
let plan;
try { plan = JSON.parse(readFileSync(file, 'utf8')); }
catch (error) { process.stderr.write(JSON.stringify({ valid: false, errors: [error.message] }) + '\n'); process.exit(1); }
const errors = [];
const sections = Array.isArray(plan.sections) ? plan.sections : [];
if (!Array.isArray(plan.sections) || sections.length === 0) errors.push('sections must be a non-empty array');
const ids = new Map();
const ordered = [];
for (const [sectionIndex, section] of sections.entries()) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(section?.id || '')) errors.push(`sections[${sectionIndex}].id is invalid`);
  if (!Array.isArray(section?.exercises) || section.exercises.length === 0) errors.push(`sections[${sectionIndex}].exercises must be non-empty`);
  for (const [exerciseIndex, exercise] of (section?.exercises || []).entries()) {
    const location = `sections[${sectionIndex}].exercises[${exerciseIndex}]`;
    if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) { errors.push(`${location} must be an object`); continue; }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exercise?.id || '')) errors.push(`${location}.id is invalid`);
    if (ids.has(exercise?.id)) errors.push(`duplicate exercise id: ${exercise.id}`);
    else ids.set(exercise?.id, ordered.length);
    ordered.push(exercise);
    if (typeof exercise?.objective !== 'string' || exercise.objective.trim().length < 20) errors.push(`${location}.objective must contain at least 20 characters`);
    if (!Array.isArray(exercise?.prerequisites)) errors.push(`${location}.prerequisites must be an array`);
    const variants = exercise?.variants;
    if (!Array.isArray(variants) || variants.length === 0) errors.push(`${location}.variants must be non-empty`);
    else for (const variant of variants) if (!['explainer', 'guided', 'problem', 'solution', 'assessment'].includes(variant)) errors.push(`${location} has unknown variant ${variant}`);
  }
}
for (const exercise of ordered) for (const prerequisite of exercise?.prerequisites || []) {
  if (!ids.has(prerequisite)) errors.push(`${exercise.id} references missing prerequisite ${prerequisite}`);
  else if (ids.get(prerequisite) >= ids.get(exercise.id)) errors.push(`${exercise.id} prerequisite ${prerequisite} must appear earlier`);
}
process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors, sectionCount: sections.length, exerciseCount: ordered.length }, null, 2) + '\n');
if (errors.length) process.exit(1);
