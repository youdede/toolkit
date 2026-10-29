// Credential paths (shared block `sensitive-paths`): the one definition behind sensitive-file-access-guard,
// the read-only MCP runtime, commit-guard, and the repository's own scan (scripts/lib/secret-scan.mjs).
// Edit it here and run `npm run shared-hooks`.
//
// isCredentialPath is the access tier: environment files, private SSH identities, credential directories,
// and the credential-store files of common clients. Nothing may read or commit them. isCommitSecretPath
// is the commit tier. It adds key and keystore extensions and `credentials`/`secrets` files, which a
// project may read (a `.pem` can be a public certificate) but should not commit. It drops `.npmrc`,
// which projects commit for registry settings; a token inside it is caught by the npm-token content rule.

const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];
// A credential directory is sensitive itself and so is everything under it, at any depth; `.ssh` keeps
// its own rule because its public keys, config, and known_hosts are safe.
const SENSITIVE_DIRECTORY_SUFFIXES = ['/.aws', '/.azure', '/.config/gcloud', '/.gnupg', '/.kube', '/.ssh'];
const SAFE_SSH_FILES = new Set(['authorized_keys', 'config', 'known_hosts']);
const EXACT_CREDENTIAL_SUFFIXES = [
  '/.aws/credentials',
  '/.azure/accesstokens.json',
  '/.config/gcloud/application_default_credentials.json',
  '/.config/gh/hosts.yml',
  '/.docker/config.json',
  '/.git-credentials',
  '/.kube/config',
  '/.netrc',
  '/.npmrc',
  '/.pypirc'
];
const SSH_PRIVATE_KEY = /\/(?:\.ssh\/)?id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/;
const KEY_FILE = /\.(?:pem|p12|pfx|key|keystore|jks)$/;
const SECRETS_FILE = /^(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini))?$/;

// Lower-cased, forward slashes, one leading slash: a relative path is read from the root of its tree.
function credentialForm(value) {
  return `/${String(value).replaceAll('\\', '/').replace(/^\/+/, '')}`.toLowerCase();
}

export function isCredentialPath(value) {
  const normalized = credentialForm(value);
  const basename = normalized.split('/').at(-1);
  if (basename.startsWith('.env') && SAFE_ENV_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return false;
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (SSH_PRIVATE_KEY.test(normalized)) return true;
  if (normalized.includes('/.ssh/') && !basename.endsWith('.pub') && !SAFE_SSH_FILES.has(basename)) return true;
  if (SENSITIVE_DIRECTORY_SUFFIXES.some((suffix) => normalized.endsWith(suffix) || (suffix !== '/.ssh' && normalized.includes(`${suffix}/`)))) return true;
  return EXACT_CREDENTIAL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function isCommitSecretPath(value) {
  const normalized = credentialForm(value);
  const basename = normalized.split('/').at(-1);
  if (basename === '.npmrc') return false;
  return isCredentialPath(normalized) || KEY_FILE.test(basename) || SECRETS_FILE.test(basename);
}
