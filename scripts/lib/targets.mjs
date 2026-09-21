import os from 'node:os';
import path from 'node:path';

export const TARGETS = Object.freeze({
  'claude-code': Object.freeze({
    label: 'Claude Code',
    roots: Object.freeze({ project: '.claude', user: path.join(os.homedir(), '.claude') }),
    componentRoots: Object.freeze({
      'mcp-server': Object.freeze({ project: '.', user: path.join(os.homedir(), '.claude') })
    }),
    settingsFiles: Object.freeze({ project: 'settings.json', user: 'settings.json' })
  }),
  codex: Object.freeze({
    label: 'Codex',
    roots: Object.freeze({ project: '.agents', user: path.join(os.homedir(), '.agents') }),
    componentRoots: Object.freeze({
      hook: Object.freeze({ project: '.codex', user: path.join(os.homedir(), '.codex') }),
      subagent: Object.freeze({ project: '.codex', user: path.join(os.homedir(), '.codex') })
    }),
    settingsFiles: Object.freeze({ project: 'settings.json', user: 'settings.json' }),
    componentSettingsFiles: Object.freeze({
      hook: Object.freeze({ project: 'hooks.json', user: 'hooks.json' })
    })
  }),
  'gemini-cli': Object.freeze({
    label: 'Gemini CLI',
    roots: Object.freeze({ project: '.gemini', user: path.join(os.homedir(), '.gemini') }),
    settingsFiles: Object.freeze({ project: 'settings.json', user: 'settings.json' })
  }),
  'github-copilot': Object.freeze({
    label: 'GitHub Copilot',
    roots: Object.freeze({
      project: '.github',
      user: () => process.env.COPILOT_HOME ? path.resolve(process.env.COPILOT_HOME) : path.join(os.homedir(), '.copilot')
    }),
    settingsFiles: Object.freeze({ project: 'copilot/settings.json', user: 'settings.json' })
  }),
  cursor: Object.freeze({
    label: 'Cursor',
    roots: Object.freeze({ project: '.cursor', user: path.join(os.homedir(), '.cursor') }),
    componentRoots: Object.freeze({
      'mcp-server': Object.freeze({ project: '.', user: path.join(os.homedir(), '.cursor') })
    }),
    settingsFiles: Object.freeze({ project: 'hooks.json', user: 'hooks.json' })
  }),
  opencode: Object.freeze({
    label: 'OpenCode',
    roots: Object.freeze({ project: '.opencode', user: path.join(os.homedir(), '.config', 'opencode') }),
    settingsFiles: Object.freeze({ project: '../opencode.json', user: 'opencode.json' })
  })
});

export const SUPPORTED_TARGETS = Object.freeze(Object.keys(TARGETS));

export function targetDefinition(target) {
  const definition = TARGETS[target];
  if (!definition) throw new Error(`unsupported target '${target}'`);
  return definition;
}

function resolveRootValue(value, scope, cwd) {
  const resolved = typeof value === 'function' ? value() : value;
  return scope === 'user' ? path.resolve(resolved) : path.join(path.resolve(cwd), resolved);
}

export function resolveConfigRoot(target, scope, cwd = process.cwd(), kind = null) {
  const definition = targetDefinition(target);
  if (!['project', 'user'].includes(scope)) throw new Error(`unsupported scope '${scope}'`);
  const roots = kind ? definition.componentRoots?.[kind] || definition.roots : definition.roots;
  return resolveRootValue(roots[scope], scope, cwd);
}

export const ARTIFACT_KINDS = Object.freeze(['skill', 'hook', 'subagent', 'command', 'context', 'mcp-server']);

export function resolveConfigRoots(target, scope, cwd = process.cwd()) {
  const roots = ARTIFACT_KINDS.map((kind) => resolveConfigRoot(target, scope, cwd, kind));
  return Object.freeze([...new Set(roots)]);
}

export function defaultSettingsPath(target, configRoot, scope = 'project', kind = null) {
  const definition = targetDefinition(target);
  const files = kind ? definition.componentSettingsFiles?.[kind] || definition.settingsFiles : definition.settingsFiles;
  return path.resolve(configRoot, files[scope]);
}
