import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { auditUrl } from './auditor.mjs';

const require = createRequire(import.meta.url);
const outputDir = path.resolve('audit-report');
const contentSelector = process.env.AUDIT_CONTENT_SELECTOR || '#MainContent';
const port = Number(process.env.AUDIT_PORT || 4174);
const origin = `http://127.0.0.1:${port}`;
let server;
let serverLog;

function cell(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;').replace(/\r?\n/g, '<br>');
}

function annotation(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A').replaceAll(',', '%2C').replaceAll(':', '%3A');
}

async function writeReports(report) {
  const markdown = [
    '# Website audit',
    '',
    `Page: ${cell(report.url)}`,
    `Content selector: ${cell(contentSelector)}`,
    '',
    report.error ? `**Could not complete the audit:** ${cell(report.error)}`
      : `**${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.skipped} skipped** (check categories, not individual links)`,
    '',
    '| Check | Result | Details | Suggested action |',
    '| --- | --- | --- | --- |',
    ...(report.results || []).map(result =>
      `| ${cell(result.label)} | ${cell(result.status)} | ${cell(result.details)} | ${cell(result.status === 'fail' ? result.suggestion : '')} |`
    ),
    '',
  ].join('\n');
  await fs.writeFile(path.join(outputDir, 'audit.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(outputDir, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

async function assertPortAvailable() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

async function startSite() {
  await assertPortAvailable();
  serverLog = createWriteStream(path.join(outputDir, 'server.log'));
  server = spawn(process.execPath, [
    require.resolve('http-server/bin/http-server'),
    path.resolve(process.env.AUDIT_SITE_ROOT || '.'),
    '-a', '127.0.0.1', '-p', String(port), '-c-1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  let startupError;
  server.once('error', error => { startupError = error; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error('The temporary site server exited; see audit-report/server.log.');
    }
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('The temporary site server did not start within 30 seconds.');
}

async function stopSite() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'close');
    server.kill('SIGTERM');
    const killTimeout = setTimeout(() => server.kill('SIGKILL'), 5000);
    killTimeout.unref();
    try { await closed; } finally { clearTimeout(killTimeout); }
  }
  if (serverLog) await new Promise(resolve => serverLog.end(resolve));
}

await fs.mkdir(outputDir, { recursive: true });
let target;
try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AUDIT_PORT must be between 1 and 65535.');
  target = new URL(process.env.AUDIT_PATH || '/index.html', origin);
  if (target.origin !== origin) throw new Error('AUDIT_PATH must refer to this checkout, for example /index.html.');
  process.env.AUDIT_BROWSER_PATH ||= chromium.executablePath();
  await startSite();
  const report = await auditUrl(target.href, { contentSelector });
  await writeReports(report);
  for (const result of report.results) {
    console.log(`[${result.status}] ${result.label}: ${result.details.replace(/\r?\n/g, ' ')}`);
    if (result.status === 'fail' && process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::error title=${annotation(result.label)}::${annotation(result.details)}`);
    }
  }
  console.log(`Audit finished: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`);
  process.exitCode = report.summary.failed > 0 ? 1 : 0;
} catch (error) {
  await writeReports({
    url: target?.href || process.env.AUDIT_PATH || '/index.html',
    auditedAt: new Date().toISOString(),
    error: error.message,
    results: [],
  });
  console.error(`Audit could not complete: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopSite();
}
