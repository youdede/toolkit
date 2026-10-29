#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;

// <youdede:shared secret-rules>
// High-confidence credential formats (shared block `secret-rules`): the one list behind commit-guard,
// prompt-secret-guard, and the repository's own scan (scripts/lib/secret-scan.mjs). Edit it here and run
// `npm run shared-hooks`.
//
// A rule is admitted only when the value itself proves it is a credential: a provider prefix, a fixed
// structure, or a key header. These hooks block with no exception, so a rule that needs a keyword next to
// the value, an entropy guess, a bare hex string, a UUID, or a JWT is left out (each matches hashes,
// identifiers, or documentation samples). For the same reason test-mode keys whose samples fill public
// documentation (Stripe `sk_test_`) are not rules. Each pattern stops at a character that cannot continue
// the token, and none nests a quantifier, so a scan stays linear in the text.
//
// Many patterns are adapted from the gitleaks default configuration (config/gitleaks.toml, v8.30.1),
// rewritten for JavaScript and tightened where gitleaks relies on its keyword prefilter, which this list
// does not have. Provider formats were cross-checked with OpenRouter's published secret formats
// (2026-10). Notice for the adapted patterns:
//   gitleaks, MIT License, Copyright (c) 2019 Zachary Rice. Permission is hereby granted, free of charge,
//   to any person obtaining a copy of this software and associated documentation files (the "Software"),
//   to deal in the Software without restriction, including without limitation the rights to use, copy,
//   modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
//   persons to whom the Software is furnished to do so, subject to the following conditions: The above
//   copyright notice and this permission notice shall be included in all copies or substantial portions
//   of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
//   OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
//   CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
const secretRule = (id, label, pattern, accept) => Object.freeze(accept ? { id, label, pattern, accept } : { id, label, pattern });

export const SECRET_RULES = Object.freeze([
  // Key material.
  // Every PEM and PGP private key header, encrypted ones included (`ENCRYPTED PRIVATE KEY`, `PGP PRIVATE KEY BLOCK`).
  secretRule('private-key', 'private key block', /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/),
  secretRule('putty-private-key', 'PuTTY private key file', /\bPuTTY-User-Key-File-\d: /),
  secretRule('age-secret-key', 'age secret key', /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/),
  secretRule('bitcoin-extended-private-key', 'Bitcoin extended private key', /\b[xyzYZtuvUV]prv[1-9A-HJ-NP-Za-km-z]{107,108}\b/),

  // Cloud providers.
  secretRule('aws-access-key', 'AWS access key id', /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/),
  secretRule('aws-bedrock-api-key', 'Amazon Bedrock API key', /\bABSK[A-Za-z0-9+/]{109,269}={0,2}|\bbedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29t/),
  // A key may end in `-`, after which `\b` would never match.
  secretRule('google-api-key', 'Google API key', /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/),
  secretRule('google-oauth-client-secret', 'Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9_-])/),
  secretRule('firebase-messaging-server-key', 'Firebase Cloud Messaging server key', /\bAAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{134}/),
  secretRule('azure-ad-client-secret', 'Microsoft Entra client secret', /(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])/),
  secretRule('azure-storage-account-key', 'Azure storage account key', /\bAccountKey=[A-Za-z0-9+/]{86}==/),
  secretRule('alibaba-access-key-id', 'Alibaba Cloud access key id', /\bLTAI[A-Za-z0-9]{20}\b/),
  secretRule('digitalocean-token', 'DigitalOcean token', /\bdo[oprs]_v1_[a-f0-9]{64}\b/),
  secretRule('heroku-api-key', 'Heroku API key', /\bHRKU-AA[0-9A-Za-z_-]{58}(?![0-9A-Za-z_-])/),
  secretRule('cloudflare-origin-ca-key', 'Cloudflare Origin CA key', /\bv1\.0-[a-f0-9]{24}-[a-f0-9]{146}\b/),
  secretRule('flyio-token', 'Fly.io token', /\b(?:fo1_[\w-]{43}|fm1[ar]_[A-Za-z0-9+/]{100,}={0,3}|fm2_[A-Za-z0-9+/]{100,}={0,3})(?![\w-])/),
  secretRule('scalingo-token', 'Scalingo API token', /\btk-us-[\w-]{48}(?![\w-])/),
  secretRule('openshift-user-token', 'OpenShift user token', /\bsha256~[\w-]{43}(?![\w-])/),
  secretRule('yandex-api-key', 'Yandex Cloud API key', /\bAQVN[A-Za-z0-9_-]{35,38}(?![A-Za-z0-9_-])/),
  secretRule('supabase-secret-key', 'Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}/),
  secretRule('supabase-access-token', 'Supabase access token', /\bsbp_[a-f0-9]{40}\b/),
  secretRule('neon-api-key', 'Neon API key', /\bnapi_[a-z0-9]{64}\b/),
  secretRule('netlify-token', 'Netlify access token', /\bnfp_[A-Za-z0-9]{36}\b/),
  secretRule('clickhouse-cloud-secret', 'ClickHouse Cloud API secret', /\b4b1d[A-Za-z0-9]{38}\b/),
  secretRule('databricks-token', 'Databricks API token', /\bdapi[a-f0-9]{32}(?:-\d)?\b/),
  secretRule('planetscale-token', 'PlanetScale token or password', /\bpscale_(?:tkn|oauth|pw)_[\w=.-]{32,64}(?![\w=.-])/),

  // Source control, registries, CI/CD, and infrastructure.
  secretRule('github-token', 'GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/),
  secretRule('github-fine-grained-token', 'GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/),
  secretRule('gitlab-token', 'GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/),
  secretRule('gitlab-deploy-token', 'GitLab deploy token', /\bgldt-[0-9a-zA-Z_-]{20}/),
  secretRule('gitlab-feature-flag-token', 'GitLab feature flag client token', /\bglffct-[0-9a-zA-Z_-]{20}/),
  secretRule('gitlab-feed-token', 'GitLab feed token', /\bglft-[0-9a-zA-Z_-]{20}/),
  secretRule('gitlab-incoming-mail-token', 'GitLab incoming mail token', /\bglimt-[0-9a-zA-Z_-]{25}/),
  secretRule('gitlab-agent-token', 'GitLab Kubernetes agent token', /\bglagent-[0-9a-zA-Z_-]{50}/),
  secretRule('gitlab-oauth-secret', 'GitLab OAuth application secret', /\bgloas-[0-9a-zA-Z_-]{64}/),
  secretRule('gitlab-trigger-token', 'GitLab pipeline trigger token', /\bglptt-[0-9a-f]{40}\b/),
  secretRule('gitlab-runner-token', 'GitLab runner authentication token', /\bglrt-[0-9a-zA-Z_-]{20,}/),
  secretRule('gitlab-runner-registration-token', 'GitLab runner registration token', /\bGR1348941[\w-]{20}/),
  secretRule('gitlab-scim-token', 'GitLab SCIM token', /\bglsoat-[0-9a-zA-Z_-]{20}/),
  secretRule('gitlab-job-token', 'GitLab CI/CD job token', /\bglcbt-[0-9a-zA-Z]{1,5}_[0-9a-zA-Z_-]{20}/),
  secretRule('gitlab-session-cookie', 'GitLab session cookie', /\b_gitlab_session=[0-9a-z]{32}\b/),
  secretRule('bitbucket-app-password', 'Bitbucket app password', /\bATBB[A-Za-z0-9_=.-]{28,}/),
  secretRule('atlassian-api-token', 'Atlassian API token', /\bATATT3[A-Za-z0-9_\-=]{186}/),
  secretRule('docker-hub-token', 'Docker Hub access token', /\bdckr_pat_[A-Za-z0-9_-]{27,}/),
  secretRule('npm-token', 'npm token', /\bnpm_[A-Za-z0-9]{36}\b/),
  secretRule('pypi-token', 'PyPI token', /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/),
  secretRule('rubygems-token', 'RubyGems API key', /\brubygems_[a-f0-9]{48}\b/),
  secretRule('clojars-token', 'Clojars deploy token', /\bCLOJARS_[A-Za-z0-9]{60}\b/),
  secretRule('artifactory-token', 'JFrog Artifactory API key or reference token', /\b(?:AKCp[A-Za-z0-9]{69}|cmVmd[A-Za-z0-9]{59})\b/),
  secretRule('sourcegraph-token', 'Sourcegraph access token', /\bsgp_(?:(?:[a-fA-F0-9]{16}|local)_)?[a-fA-F0-9]{40}\b/),
  secretRule('octopus-deploy-key', 'Octopus Deploy API key', /\bAPI-[A-Z0-9]{26}\b/),
  secretRule('harness-token', 'Harness API key', /\b(?:pat|sat)\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{20}\b/),
  secretRule('terraform-cloud-token', 'Terraform Cloud API token', /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,70}/),
  secretRule('vault-token', 'HashiCorp Vault token', /\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/),
  secretRule('pulumi-token', 'Pulumi access token', /\bpul-[a-f0-9]{40}\b/),
  secretRule('infracost-token', 'Infracost API key', /\bico-[A-Za-z0-9]{32}\b/),
  secretRule('prefect-token', 'Prefect API key', /\bpnu_[A-Za-z0-9]{36}\b/),
  secretRule('doppler-token', 'Doppler token', /\bdp\.(?:pt|st|ct|sa|scim|audit)\.[A-Za-z0-9]{40,44}\b/),
  secretRule('onepassword-secret-key', '1Password secret key', /\bA3-[A-Z0-9]{6}-(?:[A-Z0-9]{11}|[A-Z0-9]{6}-[A-Z0-9]{5})-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/),
  secretRule('onepassword-service-token', '1Password service account token', /\bops_eyJ[A-Za-z0-9+/]{250,}={0,3}/),
  secretRule('authress-key', 'Authress service client key', /\b(?:sc|ext|scauth|authress)_[A-Za-z0-9]{5,30}\.[A-Za-z0-9]{4,6}\.acc[_-][A-Za-z0-9-]{10,32}\.[A-Za-z0-9+/_=-]{30,120}/),
  secretRule('defined-networking-key', 'Defined Networking API key', /\bdnkey-[A-Za-z0-9=_-]{26}-[A-Za-z0-9=_-]{52}/),
  secretRule('sidekiq-credentials', 'Sidekiq Enterprise credentials in a URL', /\bhttps?:\/\/[a-f0-9]{8}:[a-f0-9]{8}@(?:gems|enterprise)\.contribsys\.com/i),

  // Observability, analytics, and product services.
  secretRule('dynatrace-token', 'Dynatrace API token', /\bdt0c01\.[A-Za-z0-9]{24}\.[A-Za-z0-9]{64}\b/),
  secretRule('grafana-api-key', 'Grafana API key', /\beyJrIjoi[A-Za-z0-9]{70,400}={0,3}/),
  secretRule('grafana-cloud-token', 'Grafana Cloud token', /\bglc_[A-Za-z0-9+/]{32,400}={0,3}/),
  secretRule('grafana-service-account-token', 'Grafana service account token', /\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b/),
  secretRule('sentry-token', 'Sentry auth token', /\bsntryu_[a-f0-9]{64}\b|\bsntrys_eyJpYXQiO[A-Za-z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[A-Za-z0-9+/]{10,200}={0,2}_[A-Za-z0-9+/]{43}/),
  secretRule('new-relic-key', 'New Relic user or insert key', /\bNRAK-[A-Z0-9]{27}\b|\bNRII-[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/),
  secretRule('linear-api-key', 'Linear API key', /\blin_api_[A-Za-z0-9]{40}\b/),
  secretRule('notion-token', 'Notion integration token', /\bntn_[0-9]{11}[A-Za-z0-9]{35}\b/),
  secretRule('airtable-token', 'Airtable personal access token', /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/),
  secretRule('typeform-token', 'Typeform API token', /\btfp_[A-Za-z0-9_.=-]{59}(?![A-Za-z0-9_.=-])/),
  secretRule('frameio-token', 'Frame.io API token', /\bfio-u-[A-Za-z0-9_=-]{64}(?![A-Za-z0-9_=-])/),
  secretRule('readme-token', 'ReadMe API key', /\brdme_[a-z0-9]{70}\b/),
  secretRule('postman-token', 'Postman API key', /\bPMAK-[A-Fa-f0-9]{24}-[A-Fa-f0-9]{34}\b/),
  secretRule('maxmind-license-key', 'MaxMind license key', /\b[A-Za-z0-9]{6}_[A-Za-z0-9]{29}_mmk\b/),
  secretRule('settlemint-token', 'SettleMint access token', /\bsm_(?:aat|pat|sat)_[A-Za-z0-9]{16}\b/),
  secretRule('intra42-client-secret', '42 Intra client secret', /\bs-s4t2(?:ud|af)-[a-f0-9]{64}\b/),
  secretRule('adobe-client-secret', 'Adobe client secret', /\bp8e-[A-Za-z0-9]{32}(?![A-Za-z0-9])/),
  secretRule('mapbox-secret-token', 'Mapbox secret token', /\bsk\.eyJ1Ijoi[A-Za-z0-9._-]{60,}/),
  secretRule('dropbox-token', 'Dropbox access token', /\bsl\.(?:u\.)?[A-Za-z0-9_-]{130,}/),
  secretRule('facebook-page-token', 'Facebook access token', /\bEAA[MC][A-Za-z0-9]{100,}\b/),
  secretRule('facebook-app-token', 'Facebook app access token', /\b\d{15,16}(?:\||%7C)[0-9A-Za-z_-]{27,40}(?![0-9A-Za-z_-])/),
  secretRule('shopify-token', 'Shopify access token or shared secret', /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/),
  secretRule('freemius-secret-key', 'Freemius secret key', /["']secret_key["']\s*=>\s*["']sk_\S{29}["']/),

  // Messaging and email.
  secretRule('slack-token', 'Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/),
  secretRule('slack-config-token', 'Slack configuration token', /\bxoxe(?:\.xox[bp])?-\d-[A-Za-z0-9]{146,166}\b/),
  secretRule('slack-app-token', 'Slack app-level token', /\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/i),
  secretRule('slack-webhook', 'Slack webhook URL', /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/),
  secretRule('teams-webhook', 'Microsoft Teams webhook URL', /https:\/\/[a-z0-9]+\.webhook\.office\.com\/webhookb2\/[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}@[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}\/IncomingWebhook\/[a-z0-9]{32}\/[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}/),
  secretRule('discord-webhook', 'Discord webhook URL', /\bdiscord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,72}/),
  secretRule('discord-bot-token', 'Discord bot token', /\b[MNO][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/),
  secretRule('telegram-bot-token', 'Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/),
  secretRule('twilio-api-key', 'Twilio API key', /\bSK[0-9a-fA-F]{32}\b/),
  // A SendGrid key may end in `-`, after which `\b` would never match.
  secretRule('sendgrid-key', 'SendGrid API key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/),
  secretRule('brevo-key', 'Brevo (Sendinblue) API or SMTP key', /\bx(?:keysib|smtpsib)-[a-f0-9]{64}-[A-Za-z0-9]{16}\b/),
  secretRule('mailchimp-key', 'Mailchimp API key', /\b[0-9a-f]{32}-us\d{1,2}\b/),

  // Payments and commerce.
  secretRule('stripe-live-key', 'Stripe live key', /\b(?:sk|rk)_(?:live|prod)_[A-Za-z0-9]{16,}\b/),
  secretRule('stripe-webhook-secret', 'Stripe webhook signing secret', /\bwhsec_[A-Za-z0-9+/=]{32,}/),
  secretRule('square-token', 'Square access token or application secret', /\bsq0(?:atp|csp)-[\w-]{22,60}(?![\w-])/),
  secretRule('braintree-token', 'Braintree or PayPal production access token', /\baccess_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32}\b/),
  secretRule('shippo-live-token', 'Shippo live API token', /\bshippo_live_[a-fA-F0-9]{40}\b/),
  secretRule('easypost-key', 'EasyPost API key', /\bEZ[AT]K[A-Za-z0-9]{54}\b/),
  secretRule('duffel-token', 'Duffel API token', /\bduffel_(?:test|live)_[A-Za-z0-9_=-]{43}(?![A-Za-z0-9_=-])/),
  secretRule('flutterwave-key', 'Flutterwave secret or encryption key', /\bFLWSECK(?:_TEST)?-[a-hA-H0-9]{12}/),

  // AI and model providers. The specific prefixes come before the broad OpenAI shape.
  secretRule('anthropic-key', 'Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/),
  secretRule('openrouter-key', 'OpenRouter API key', /\bsk-or-v1-[a-f0-9]{64}\b/),
  // A key body is random; lowercase words joined by `-` (sk-dashboard-components-v2-legacy) name something.
  // Anthropic and OpenRouter keys share the `sk-` start and have their own rules above.
  secretRule('openai-key', 'OpenAI API key', /\bsk-(?!ant-|or-v1-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, (match) => !/^sk-(?:proj-)?[a-z0-9]+(?:-[a-z0-9]+)+$/.test(match)),
  secretRule('groq-key', 'Groq API key', /\bgsk_[A-Za-z0-9]{48,}\b/),
  secretRule('xai-key', 'xAI API key', /\bxai-[A-Za-z0-9]{70,}\b/),
  secretRule('perplexity-key', 'Perplexity API key', /\bpplx-[A-Za-z0-9]{48}\b/),
  secretRule('replicate-token', 'Replicate API token', /\br8_[A-Za-z0-9]{37}\b/),
  secretRule('huggingface-token', 'Hugging Face token', /\b(?:hf_|api_org_)[A-Za-z]{34}\b/),
  secretRule('langsmith-key', 'LangSmith API key', /\blsv2_(?:pt|sk)_[a-f0-9]{32}_[a-f0-9]{10}\b/),
  secretRule('tavily-key', 'Tavily API key', /\btvly-(?:dev-|prod-)?[A-Za-z0-9]{32}\b/),
  secretRule('pinecone-key', 'Pinecone API key', /\bpcsk_[A-Za-z0-9_]{40,}\b/)
]);

// The first match of `rule` in `text` that the rule accepts, or null.
export function secretMatch(rule, text) {
  if (!rule.accept) return rule.pattern.exec(text);
  return [...text.matchAll(rule.pattern)].find(([match]) => rule.accept(match)) ?? null;
}
// </youdede:shared>

function allow() {
  return { exitCode: 0, ruleId: 'prompt-secret-clear', output: null };
}

const ADVICE = {
  'prompt-analysis-limit': 'Split the prompt into parts smaller than 256 KiB.',
  'prompt-envelope-invalid': 'The hook input could not be read; resubmit the prompt, and check the hook installation if this repeats.'
};

function block(ruleId, reason) {
  return {
    exitCode: 0,
    ruleId,
    output: {
      decision: 'block',
      reason: `Blocked by prompt-secret-guard [${ruleId}]: ${reason}. ${ADVICE[ruleId] ?? 'Remove or redact the credential before resubmitting.'}`,
      suppressOriginalPrompt: true
    }
  };
}

export function evaluate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return block('prompt-envelope-invalid', 'the prompt envelope is not a JSON object');
  }
  if (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit') return allow();
  if (typeof input.prompt !== 'string') return block('prompt-envelope-invalid', 'the prompt field is missing');
  if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return block('prompt-analysis-limit', `the prompt exceeds the ${MAX_PROMPT_BYTES}-byte inspection limit`);
  }
  for (const rule of SECRET_RULES) {
    if (secretMatch(rule, input.prompt)) return block(`prompt-${rule.id}`, 'a high-confidence credential format was detected');
  }
  return allow();
}

async function receiveEnvelope() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_STDIN_BYTES) throw new Error('prompt input exceeds the bounded size');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error('prompt input is not valid JSON');
  }
}

async function runHook() {
  let decision;
  try {
    decision = evaluate(await receiveEnvelope());
  } catch (error) {
    decision = block('prompt-envelope-invalid', error.message);
  }
  if (decision.output) process.stdout.write(`${JSON.stringify(decision.output)}\n`);
  process.exitCode = decision.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await runHook();
