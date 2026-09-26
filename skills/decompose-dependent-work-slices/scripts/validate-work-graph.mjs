#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  process.stderr.write('usage: validate-work-graph.mjs <graph.json>\n');
  process.exit(2);
}

let graph;
try { graph = JSON.parse(readFileSync(file, 'utf8')); }
catch (error) { process.stderr.write(JSON.stringify({ valid: false, errors: [error.message] }) + '\n'); process.exit(1); }

const errors = [];
const tickets = Array.isArray(graph.tickets) ? graph.tickets : [];
if (!Array.isArray(graph.tickets)) errors.push('tickets must be an array');
const byId = new Map();
for (const [index, ticket] of tickets.entries()) {
  if (!ticket || typeof ticket !== 'object') { errors.push(`tickets[${index}] must be an object`); continue; }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(ticket.id || '')) errors.push(`tickets[${index}].id must be lowercase hyphen-case`);
  if (byId.has(ticket.id)) errors.push(`duplicate ticket id: ${ticket.id}`);
  else byId.set(ticket.id, ticket);
  if (typeof ticket.title !== 'string' || ticket.title.trim().length < 3) errors.push(`tickets[${index}].title is required`);
  if (!Array.isArray(ticket.blockedBy)) errors.push(`tickets[${index}].blockedBy must be an array`);
}
for (const ticket of tickets) for (const blocker of ticket.blockedBy || []) {
  if (blocker === ticket.id) errors.push(`${ticket.id} blocks itself`);
  else if (!byId.has(blocker)) errors.push(`${ticket.id} references missing blocker ${blocker}`);
}
// Missing blockers and self-blocks are reported above; counting them here would also report a false cycle.
const realBlockers = (ticket) => (ticket.blockedBy || []).filter((blocker) => blocker !== ticket.id && byId.has(blocker));
const indegree = new Map(tickets.map((ticket) => [ticket.id, realBlockers(ticket).length]));
const dependents = new Map(tickets.map((ticket) => [ticket.id, []]));
for (const ticket of tickets) for (const blocker of realBlockers(ticket)) dependents.get(blocker).push(ticket.id);
const frontier = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
const queue = [...frontier];
const order = [];
while (queue.length) {
  const id = queue.shift(); order.push(id);
  for (const dependent of (dependents.get(id) || []).sort()) {
    indegree.set(dependent, indegree.get(dependent) - 1);
    if (indegree.get(dependent) === 0) queue.push(dependent);
  }
  queue.sort();
}
if (order.length !== tickets.length) errors.push(`dependency cycle includes: ${tickets.filter((ticket) => !order.includes(ticket.id)).map((ticket) => ticket.id).sort().join(', ')}`);
process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors, frontier, topologicalOrder: order }, null, 2) + '\n');
if (errors.length) process.exit(1);
