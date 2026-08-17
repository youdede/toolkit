const NPM_PACK_ARGUMENTS = Object.freeze(['pack', '--dry-run', '--json', '--ignore-scripts']);

export function resolveNpmPackInvocation({
  platform = process.platform,
  nodeExecutable = process.execPath,
  npmExecPath = process.env.npm_execpath
} = {}) {
  if (typeof npmExecPath === 'string' && npmExecPath.trim()) {
    return {
      command: nodeExecutable,
      argumentsList: [npmExecPath, ...NPM_PACK_ARGUMENTS],
      shell: false
    };
  }
  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    argumentsList: [...NPM_PACK_ARGUMENTS],
    shell: platform === 'win32'
  };
}

export function spawnFailureDetail(outcome) {
  if (outcome?.error) {
    return [outcome.error.code, outcome.error.message].filter(Boolean).join(': ');
  }
  return typeof outcome?.stderr === 'string' ? outcome.stderr.trim() : '';
}
