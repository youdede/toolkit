#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 256 * 1024;
export const MAX_TOKENS = 4096;
export const MAX_NESTING = 3;

const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell']);
const PREFIX_COMMANDS = new Set(['command', 'exec', 'env', 'nohup', 'nice', 'sudo', 'time']);
const STREAM_SINKS = new Set(['nc', 'ncat', 'netcat', 'sftp', 'socat', 'ssh']);
const CURL_NAMES = new Set(['curl']);
const POWERSHELL_HTTP = new Set(['invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm']);

function allow() {
  return { exitCode: 0, ruleId: null, message: '' };
}

function deny(ruleId, reason) {
  return {
    exitCode: 2,
    ruleId,
    message: `BLOCKED by outbound-data-guard [${ruleId}]: ${reason}. Command, destination, path, and payload values were not printed.`
  };
}

function consumeExpansion(source, offset) {
  if (source[offset] === '`') {
    let cursor = offset + 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') cursor += 2;
      else if (source[cursor++] === '`') return cursor;
    }
    return -1;
  }
  const opening = source[offset + 1];
  if (opening !== '(' && opening !== '{') {
    const variable = /^\$[A-Za-z_][A-Za-z0-9_]*|^\$[0-9@*#?$!_-]/.exec(source.slice(offset));
    return variable ? offset + variable[0].length : offset + 1;
  }
  const closing = opening === '(' ? ')' : '}';
  let depth = 1;
  let quoted = null;
  for (let cursor = offset + 2; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '\\') { cursor += 1; continue; }
    if (quoted) { if (character === quoted) quoted = null; continue; }
    if (character === "'" || character === '"') { quoted = character; continue; }
    if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) return cursor + 1;
  }
  return -1;
}

function parseCommandLine(source) {
  const commands = [];
  let argv = [];
  let word = null;
  let quoted = null;
  let nextIsPiped = false;
  let tokenCount = 0;
  const ensureWord = () => { word ??= { value: '', dynamic: false, kind: 'word' }; };
  const finishWord = () => {
    if (!word) return;
    argv.push(word);
    tokenCount += 1;
    word = null;
  };
  const finishCommand = (separator) => {
    finishWord();
    if (argv.length) commands.push({ tokens: argv, inboundPipe: nextIsPiped });
    argv = [];
    nextIsPiped = separator === '|';
  };

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quoted === "'") {
      if (character === "'") quoted = null;
      else word.value += character;
      continue;
    }
    if (quoted === '"') {
      if (character === '"') quoted = null;
      else if (character === '\\') {
        if (++cursor >= source.length) return { error: true, commands: [] };
        word.value += source[cursor];
      } else if (character === '$' || character === '`') {
        const end = consumeExpansion(source, cursor);
        if (end < 0) return { error: true, commands: [] };
        word.value += source.slice(cursor, end);
        word.dynamic = true;
        cursor = end - 1;
      } else word.value += character;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      if (character === '\n') finishCommand(';');
    } else if (character === "'" || character === '"') {
      ensureWord();
      quoted = character;
    } else if (character === '\\') {
      ensureWord();
      if (++cursor >= source.length) return { error: true, commands: [] };
      word.value += source[cursor];
    } else if (character === '$' || character === '`') {
      ensureWord();
      const end = consumeExpansion(source, cursor);
      if (end < 0) return { error: true, commands: [] };
      word.value += source.slice(cursor, end);
      word.dynamic = true;
      cursor = end - 1;
    } else if (character === '|' || character === ';' || character === '&') {
      finishCommand(character === '|' ? '|' : ';');
      if (source[cursor + 1] === character) cursor += 1;
      else if (character === '|' && source[cursor + 1] === '&') cursor += 1;
    } else if (character === '<' || character === '>') {
      finishWord();
      let value = character;
      if (source[cursor + 1] === character || source[cursor + 1] === '&') value += source[++cursor];
      argv.push({ value, dynamic: false, kind: 'redirect' });
      tokenCount += 1;
    } else if (character === '(' || character === ')') {
      finishCommand(';');
    } else {
      ensureWord();
      word.value += character;
      if ('*?['.includes(character)) word.dynamic = true;
    }
    if (tokenCount > MAX_TOKENS) return { error: true, commands: [] };
  }
  if (quoted) return { error: true, commands: [] };
  finishCommand(';');
  return { error: false, commands };
}

function commandName(token) {
  return token.value.replaceAll('\\', '/').split('/').at(-1).replace(/\.exe$/i, '').toLowerCase();
}

function advancePrefix(tokens, start, name) {
  let cursor = start;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.dynamic) return -1;
    if (token.value === '--') return cursor + 1;
    if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) { cursor += 1; continue; }
    if (!token.value.startsWith('-')) return cursor;
    const takesValue = (name === 'sudo' && ['-u', '-g', '-h', '-p', '-C', '-T'].includes(token.value))
      || (name === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(token.value))
      || (name === 'nice' && ['-n', '--adjustment'].includes(token.value))
      || (name === 'time' && ['-f', '-o', '--format', '--output'].includes(token.value));
    cursor += takesValue ? 2 : 1;
  }
  return cursor;
}

function unwrap(entry, depth = 0) {
  const tokens = entry.tokens;
  let cursor = 0;
  while (cursor < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor].value)) {
    if (tokens[cursor].dynamic) return [{ ambiguous: true, inboundPipe: entry.inboundPipe }];
    cursor += 1;
  }
  for (let layers = 0; layers < 12 && cursor < tokens.length; layers += 1) {
    if (tokens[cursor].dynamic) return [{ ambiguous: true, inboundPipe: entry.inboundPipe }];
    const name = commandName(tokens[cursor]);
    if (SHELL_NAMES.has(name) || name === 'eval') {
      let payload = name === 'eval' ? cursor + 1 : -1;
      if (name !== 'eval') {
        for (let index = cursor + 1; index < tokens.length; index += 1) {
          if (tokens[index].dynamic) return [{ ambiguous: true, inboundPipe: entry.inboundPipe }];
          const control = tokens[index].value.toLowerCase();
          if (control === '-c' || control === '--command' || /^-[^-]*c[^-]*$/.test(control)) {
            payload = index + 1;
            break;
          }
          if (!tokens[index].value.startsWith('-')) break;
        }
      }
      if (payload < 0) return [{ tokens: tokens.slice(cursor), inboundPipe: entry.inboundPipe }];
      if (!tokens[payload] || tokens[payload].dynamic || depth >= MAX_NESTING) return [{ ambiguous: true, inboundPipe: entry.inboundPipe }];
      const source = name === 'eval' ? tokens.slice(payload).map((token) => token.value).join(' ') : tokens[payload].value;
      const inner = parseCommandLine(source);
      if (inner.error) return [{ ambiguous: true, inboundPipe: entry.inboundPipe }];
      return inner.commands.flatMap((command, index) => unwrap({ ...command, inboundPipe: index === 0 ? entry.inboundPipe : command.inboundPipe }, depth + 1));
    }
    if (!PREFIX_COMMANDS.has(name)) return [{ tokens: tokens.slice(cursor), inboundPipe: entry.inboundPipe }];
    cursor = advancePrefix(tokens, cursor + 1, name);
    if (cursor < 0) return [{ ambiguous: true, inboundPipe: entry.inboundPipe }];
  }
  return cursor < tokens.length ? [{ ambiguous: true, inboundPipe: entry.inboundPipe }] : [];
}

function optionValue(tokens, index) {
  const value = tokens[index].value;
  const equals = value.indexOf('=');
  if (equals >= 0) return { token: { value: value.slice(equals + 1), dynamic: tokens[index].dynamic }, next: index };
  if (/^-[A-Za-z].+/.test(value) && !value.startsWith('--')) {
    return { token: { value: value.slice(2), dynamic: tokens[index].dynamic }, next: index };
  }
  return { token: tokens[index + 1], next: index + 1 };
}

function hasInputRedirection(tokens) {
  return tokens.some((token) => token.kind === 'redirect' && token.value.startsWith('<'));
}

function curlDecision(tokens, inboundPipe) {
  const uploadOptions = new Set(['-T', '--upload-file']);
  const dataFileOptions = new Set(['-d', '--data', '--data-ascii', '--data-binary', '--data-urlencode', '--json', '--url-query']);
  const literalDataOptions = new Set(['--data-raw', '--form-string']);
  const formOptions = new Set(['-F', '--form']);
  const sensitiveValueOptions = new Set(['-H', '--header', '--proxy-header', '--oauth2-bearer']);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'redirect') { index += 1; continue; }
    const base = token.value.split('=')[0];
    const short = base.slice(0, 2);
    const option = base.startsWith('--')
      ? base.toLowerCase()
      : ['-T', '-F', '-H', '-K'].includes(short) ? short : short.toLowerCase();
    if (option === '-K' || option === '--config') return 'outbound-command-uninspectable';
    const takesPayload = uploadOptions.has(option) || dataFileOptions.has(option) || literalDataOptions.has(option)
      || formOptions.has(option) || sensitiveValueOptions.has(option);
    if (!takesPayload) continue;
    const result = optionValue(tokens, index);
    const value = result.token;
    index = result.next;
    if (!value) return 'outbound-command-uninspectable';
    if (value.dynamic) return 'outbound-dynamic-payload';
    if (sensitiveValueOptions.has(option) && value.value.startsWith('@')) return 'outbound-file-upload';
    if (uploadOptions.has(option)) return value.value === '-' && (inboundPipe || hasInputRedirection(tokens))
      ? 'outbound-stream-upload' : 'outbound-file-upload';
    if (formOptions.has(option) && /(?:^|=)[@<][^@<]/.test(value.value)) return 'outbound-file-upload';
    if (dataFileOptions.has(option)) {
      const at = option === '--data-urlencode' || option === '--url-query'
        ? /(?:^|[=])@(.+)|^[^@=]+@(.+)/.exec(value.value)
        : /^@(.+)/.exec(value.value);
      const file = at?.[1] || at?.[2];
      if (file) return file === '-' ? 'outbound-stream-upload' : 'outbound-file-upload';
    }
  }
  if (tokens.slice(1).some((token) => token.dynamic && !token.value.startsWith('-'))) return 'outbound-dynamic-payload';
  return null;
}

function wgetDecision(tokens) {
  const fileOptions = new Set(['--post-file', '--body-file']);
  const dynamicOptions = new Set(['--post-data', '--body-data', '--header']);
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index].value.split('=')[0].toLowerCase();
    if (!fileOptions.has(option) && !dynamicOptions.has(option)) continue;
    const result = optionValue(tokens, index);
    index = result.next;
    if (!result.token) return 'outbound-command-uninspectable';
    if (result.token.dynamic) return 'outbound-dynamic-payload';
    if (fileOptions.has(option)) return 'outbound-file-upload';
  }
  return null;
}

function powershellDecision(tokens) {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index].value.split(':')[0].toLowerCase();
    if (!['-infile', '-body', '-headers', '-form'].includes(option)) continue;
    const attached = tokens[index].value.includes(':')
      ? { value: tokens[index].value.slice(tokens[index].value.indexOf(':') + 1), dynamic: tokens[index].dynamic }
      : tokens[++index];
    if (!attached) return 'outbound-command-uninspectable';
    if (attached.dynamic) return 'outbound-dynamic-payload';
    if (option === '-infile') return 'outbound-file-upload';
  }
  return null;
}

function httpieDecision(tokens) {
  for (const token of tokens.slice(1)) {
    if (token.kind === 'redirect') continue;
    if (token.dynamic && /[:=@]/.test(token.value)) return 'outbound-dynamic-payload';
    if (/^(?:@|[^=@:]+@)[^@]/.test(token.value)) return 'outbound-file-upload';
  }
  return null;
}

function remoteLocation(value, kind = 'generic') {
  if (typeof value !== 'string' || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return false;
  if (/^(?:s3|gs|scp|sftp|https?):\/\//i.test(value)) return true;
  if (kind === 'rclone') return /^[A-Za-z0-9_.-]+:/.test(value);
  return /^(?:[^/@:\s]+@)?[^/:\s]+:.+/.test(value);
}

function positionalArguments(tokens, valueOptions = new Set()) {
  const values = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'redirect') { index += 1; continue; }
    if (token.value === '--') { values.push(...tokens.slice(index + 1).filter((item) => item.kind !== 'redirect')); break; }
    const option = token.value.split('=')[0];
    if (valueOptions.has(option)) { if (!token.value.includes('=')) index += 1; continue; }
    if (token.value.startsWith('-') && !token.dynamic) continue;
    values.push(token);
  }
  return values;
}

function transferDecision(name, tokens) {
  if (name === 'scp' || name === 'rsync') {
    const values = positionalArguments(tokens, new Set(['-P', '-S', '-i', '-F', '-J', '-o', '-c', '-l', '-e', '--rsh', '--exclude-from', '--files-from']));
    if (values.some((token) => token.dynamic)) return values.length >= 2 ? 'outbound-command-uninspectable' : null;
    const destination = values.at(-1)?.value;
    const sources = values.slice(0, -1);
    if (destination && remoteLocation(destination) && sources.some((source) => !remoteLocation(source.value))) return 'outbound-transfer';
  }
  if (name === 'rclone') {
    const action = tokens[1]?.value.toLowerCase();
    if (!['copy', 'copyto', 'sync', 'move', 'moveto'].includes(action)) return null;
    const values = positionalArguments([{ value: name, dynamic: false, kind: 'word' }, ...tokens.slice(2)]);
    if (values.some((token) => token.dynamic)) return 'outbound-command-uninspectable';
    if (values.length >= 2 && !remoteLocation(values[0].value, 'rclone') && remoteLocation(values[1].value, 'rclone')) return 'outbound-transfer';
  }
  if (name === 'aws' && tokens[1]?.value.toLowerCase() === 's3' && ['cp', 'sync'].includes(tokens[2]?.value.toLowerCase())) {
    const values = positionalArguments([{ value: 'transfer', dynamic: false, kind: 'word' }, ...tokens.slice(3)]);
    if (values.some((token) => token.dynamic)) return 'outbound-command-uninspectable';
    if (values.length >= 2 && !/^s3:\/\//i.test(values[0].value) && /^s3:\/\//i.test(values[1].value)) {
      return values[0].value === '-' ? 'outbound-stream-upload' : 'outbound-transfer';
    }
  }
  if (name === 'gsutil' && ['cp', 'rsync'].includes(tokens[1]?.value.toLowerCase())) {
    const values = positionalArguments([{ value: 'transfer', dynamic: false, kind: 'word' }, ...tokens.slice(2)]);
    if (values.some((token) => token.dynamic)) return 'outbound-command-uninspectable';
    if (values.length >= 2 && !/^gs:\/\//i.test(values[0].value) && /^gs:\/\//i.test(values[1].value)) return 'outbound-transfer';
  }
  if (name === 'gcloud' && tokens[1]?.value.toLowerCase() === 'storage' && ['cp', 'rsync'].includes(tokens[2]?.value.toLowerCase())) {
    const values = positionalArguments([{ value: 'transfer', dynamic: false, kind: 'word' }, ...tokens.slice(3)]);
    if (values.some((token) => token.dynamic)) return 'outbound-command-uninspectable';
    if (values.length >= 2 && !/^gs:\/\//i.test(values[0].value) && /^gs:\/\//i.test(values[1].value)) return 'outbound-transfer';
  }
  if (name === 'kubectl' && tokens[1]?.value.toLowerCase() === 'cp') {
    const values = positionalArguments([{ value: 'transfer', dynamic: false, kind: 'word' }, ...tokens.slice(2)]);
    if (values.some((token) => token.dynamic)) return 'outbound-command-uninspectable';
    if (values.length >= 2 && !remoteLocation(values[0].value) && remoteLocation(values[1].value)) return 'outbound-transfer';
  }
  if (name === 'az' && tokens[1]?.value.toLowerCase() === 'storage' && tokens[2]?.value.toLowerCase() === 'blob'
    && ['upload', 'upload-batch'].includes(tokens[3]?.value.toLowerCase())) {
    for (let index = 4; index < tokens.length; index += 1) {
      if (!['--file', '--source'].includes(tokens[index].value.split('=')[0])) continue;
      const result = optionValue(tokens, index);
      if (!result.token) return 'outbound-command-uninspectable';
      return result.token.dynamic ? 'outbound-command-uninspectable' : 'outbound-transfer';
    }
  }
  if (name === 'sftp') {
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index].value === '-b' || tokens[index].value.startsWith('-b')) return 'outbound-command-uninspectable';
    }
  }
  return null;
}

function evaluateEntry(entry) {
  if (entry.ambiguous) return 'outbound-command-uninspectable';
  if (!entry.tokens?.length) return null;
  const first = entry.tokens[0];
  if (first.dynamic) return null;
  const name = commandName(first);
  if (CURL_NAMES.has(name)) return curlDecision(entry.tokens, entry.inboundPipe);
  if (name === 'wget') return wgetDecision(entry.tokens);
  if (POWERSHELL_HTTP.has(name)) return powershellDecision(entry.tokens);
  if (['http', 'https'].includes(name)) return httpieDecision(entry.tokens);
  if (STREAM_SINKS.has(name) && (entry.inboundPipe || hasInputRedirection(entry.tokens))) {
    const flags = entry.tokens.slice(1).map((token) => token.value.toLowerCase());
    if (['nc', 'ncat', 'netcat'].includes(name) && flags.some((value) => value === '-z' || value === '--zero')) return null;
    if (name === 'ssh' && flags.some((value) => value === '-n')) return null;
    return 'outbound-stream-upload';
  }
  return transferDecision(name, entry.tokens);
}

export function evaluate(input, _context = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return deny('outbound-input-invalid', 'structured hook input is invalid');
  const data = input.tool_input ?? input.toolInput ?? input;
  const command = data?.command ?? input.command;
  const toolName = String(input.tool_name ?? input.toolName ?? '').split('__').at(-1).toLowerCase();
  if (typeof command !== 'string') return toolName && ['bash', 'powershell'].includes(toolName)
    ? deny('outbound-input-invalid', 'the shell tool input does not contain a string command')
    : allow();
  if (toolName && !['bash', 'powershell'].includes(toolName)) return allow();
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) return deny('outbound-input-invalid', 'the command exceeds a fixed analysis limit');
  const parsed = parseCommandLine(command);
  if (parsed.error) return deny('outbound-command-uninspectable', 'the shell envelope cannot be normalized safely');
  const entries = parsed.commands.flatMap((entry) => unwrap(entry));
  for (const entry of entries) {
    const rule = evaluateEntry(entry);
    if (!rule) continue;
    const reasons = {
      'outbound-file-upload': 'a network client is configured to read a local file as outbound data',
      'outbound-dynamic-payload': 'an outbound payload is constructed dynamically and cannot be inspected before execution',
      'outbound-stream-upload': 'a network process consumes a local or piped standard-input stream',
      'outbound-transfer': 'a transfer command moves a local source to a remote destination',
      'outbound-command-uninspectable': 'a protected transfer uses a configuration or argument that cannot be inspected safely'
    };
    return deny(rule, reasons[rule]);
  }
  return allow();
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error('input limit exceeded');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error('input is not valid JSON'); }
}

async function main() {
  let result;
  try { result = evaluate(await readInput()); }
  catch { result = deny('outbound-input-invalid', 'structured hook input is invalid or exceeds a fixed limit'); }
  if (result.message) process.stderr.write(`${result.message}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
