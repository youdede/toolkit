// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Youdede

// Git exports GIT_DIR and its companions into hooks and into anything a hook runs. Tests here
// create temporary repositories and shell out to git inside them; an inherited GIT_DIR overrides
// the working directory and redirects those calls at the repository under test. Every git call in
// the suite runs with these cleared, so a test result does not depend on who launched it.
export const GIT_ENVIRONMENT_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE'
];

export function cleanGitEnvironment(base = process.env) {
  const env = { ...base };
  for (const key of GIT_ENVIRONMENT_KEYS) delete env[key];
  return env;
}
