// T7 fixture: option roles verified per command key (M7). A `values` entry takes the next word, a
// `flags` entry takes none, a `safe` entry turns a safe mode on. A wrong entry can hide a verb
// (`npm --registry X publish` with `--registry` read as a flag leaves X in the verb position), so a
// declaration may use only options listed here, and every addition names its source: a local `--help`
// or configuration probe, the CLI's documentation, or a list the hook already used before this model
// (reviewed then).

const PUBLISH_GLOBAL_VALUES = ['--workspace', '-w', '--filter', '-F', '-C', '--dir', '--cwd', '--prefix', '--registry', '--userconfig',
  '--globalconfig', '--cache', '--loglevel', '--tag', '--access', '--otp', '--scope', '--include', '--omit', '--node-options',
  '--script-shell', '--reporter', '-c', '--config'];
// npm 11.19.0: `npm config get <name> --<flag> x` shows these take no value; `--no-*` negates any
// boolean config (`npm config get progress --no-progress` is false).
const NPM_FLAGS = ['--dry-run', '--silent', '-s', '--json', '--quiet', '-q', '--force', '-f', '--no-*'];
const INFRA_GLOBAL_VALUES = ['-chdir', '--chdir', '--context', '--namespace', '-n', '--kubeconfig', '--kube-context', '--as', '--as-group', '--cluster',
  '--user', '-s', '--server', '--as-uid', '--as-user-extra', '--cache-dir', '--certificate-authority', '--client-certificate', '--client-key',
  '--kuberc', '--log-flush-frequency', '--password', '--profile', '--profile-output', '--request-timeout', '--tls-server-name', '--token',
  '--username', '-v', '--v', '--vmodule', '--kube-apiserver', '--kube-as-user', '--kube-as-group', '--kube-ca-file', '--kube-token',
  '--kube-tls-server-name', '--registry-config', '--repository-cache', '--repository-config', '--burst-limit', '--qps', '--content-cache',
  '--color', '-C', '--cwd', '--verbose', '--tracing', '--tracing-header', '--profiling', '--memprofilerate', '--otel-traces'];
const CLOUD_GLOBAL_VALUES = ['--profile', '--region', '--endpoint-url', '--project', '--account', '--subscription', '--configuration',
  '--impersonate-service-account', '--output', '-o', '--query', '--color', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout',
  '--cli-binary-format', '--verbosity', '--flags-file', '--access-token-file', '--trace-token', '--billing-project', '--format'];
const ENGINE_VALUES = ['--context', '-c', '--host', '-H', '--config', '--log-level', '-l', '--tlscacert', '--tlscert', '--tlskey',
  '--url', '--connection', '--identity', '--root', '--runroot', '--storage-driver', '--cgroup-manager'];
const COMPOSE_VALUES = ['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel'];
const BUILD_VALUES = ['-t', '--tag', '-f', '--file', '--build-arg', '--target', '--platform', '--label', '--cache-from', '--cache-to',
  '--secret', '--ssh', '--network', '--progress', '--builder', '--iidfile', '--metadata-file', '-o', '--output'];
const SYSTEMCTL_VALUES = ['--host', '-H', '--machine', '-M', '--root', '--image', '--type', '-t', '--property', '-p', '--state', '--output', '-o',
  '--lines', '-n', '--signal', '-s', '--kill-whom', '--kill-value', '--job-mode', '--timestamp', '--when', '--message', '--what', '--preset-mode',
  '--boot-loader-entry', '--boot-loader-menu', '--reboot-argument', '--check-inhibitors', '--drop-in'];
const cloud = { values: CLOUD_GLOBAL_VALUES, source: 'cloud-resource-deletion-guard CLOUD_GLOBAL_VALUES at 809400c4; aws-cli 2.15.2 `aws help` lists --profile, --region, --endpoint-url, --output, --query, --color, --ca-bundle, --cli-* as taking a value' };
// docker 29.6.1 and Docker Compose v5.2.0: `docker --help` global options, `docker compose --help`, `docker build --help`, and
// `docker buildx imagetools create --help` (--dry-run); podman: container-registry-publish-guard ENGINE_GLOBAL_VALUES at 809400c4.
const engine = { values: [...ENGINE_VALUES, ...COMPOSE_VALUES, ...BUILD_VALUES], safe: ['--dry-run'], source: 'docker 29.6.1 and Compose v5.2.0 --help; podman: ENGINE_GLOBAL_VALUES at 809400c4' };
export const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source', '--list-cmds'];

const javascript = {
  values: PUBLISH_GLOBAL_VALUES,
  flags: NPM_FLAGS,
  safe: ['--dry-run', '--dry-run=true'],
  source: 'values: package-publish-guard PUBLISH_GLOBAL_VALUES at 809400c4; flags and --dry-run: npm 11.19.0 config probes; publish --help of pnpm 10.33.0 and bun 1.3.8 list --dry-run'
};
const infrastructure = { values: INFRA_GLOBAL_VALUES, source: 'infrastructure-apply-guard GLOBAL_VALUES at 809400c4 (kubectl options, helm and pulumi --help)' };

export const CLI_OPTIONS = {
  npm: javascript,
  pnpm: javascript,
  bun: javascript,
  yarn: { values: PUBLISH_GLOBAL_VALUES, source: 'package-publish-guard PUBLISH_GLOBAL_VALUES at 809400c4; yarn 1.22.22 publish --help has no --dry-run' },
  cargo: { safe: ['--dry-run', '-n'], source: 'cargo 1.92.0 publish --help: -n, --dry-run' },
  uv: { safe: ['--dry-run'], source: 'uv 0.9.26 publish --help: --dry-run' },
  poetry: { safe: ['--dry-run'], source: 'poetry documentation (publish --dry-run); not probed, kept by decision Q2' },
  terraform: infrastructure,
  tofu: infrastructure,
  pulumi: { ...infrastructure, safe: ['--preview-only', '--preview-only=true'] },
  // kubectl v1.36.1: --dry-run accepts none, server, client; only client sends nothing to the server.
  kubectl: { ...infrastructure, safe: ['--dry-run=client'] },
  // helm and pulumi are not installed here: their safe spellings are the exemptions of 809400c4 plus the
  // =true forms (capabilities.md, infrastructure-apply-guard).
  helm: { ...infrastructure, safe: ['--dry-run', '--dry-run=client', '--dry-run=true'] },
  aws: cloud,
  gsutil: cloud,
  az: cloud,
  gcloud: { values: [...CLOUD_GLOBAL_VALUES, '--filter', '--zone', '--location', '--limit', '--sort-by', '--page-size', '--flatten'], source: 'cloud-resource-deletion-guard GCLOUD_VALUE_OPTIONS at 809400c4 (gcloud list flags)' },
  docker: engine,
  podman: engine,
  'docker-compose': { values: COMPOSE_VALUES, source: 'Docker Compose v5.2.0 `docker compose --help`' },
  systemctl: { values: SYSTEMCTL_VALUES, source: 'system-service-mutation-guard SERVICE_VALUES and scheduled-task-mutation-guard SYSTEMCTL_VALUES at 809400c4 (systemctl --help)' },
  pip: { values: ['-r', '--requirement', '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '--trusted-host'], source: 'pip 25.0 `pip install --help`' },
  git: {
    values: [...GIT_VALUE_OPTIONS, '--name', '--reference', '--ref-format', '--depth'],
    flags: ['-q', '--quiet', '-f', '--force'],
    safe: ['--dry-run'],
    source: 'shared shell GIT_VALUE_OPTIONS at 809400c4 (git --help global options); git 2.54.0 `git commit -h`: --dry-run; git 2.54.0 `git submodule -h`: add takes --name and --reference with a value, -q/--quiet and -f/--force alone; --ref-format and --depth from submodule-target-guard ADD_VALUE_OPTIONS at 809400c4'
  }
};
