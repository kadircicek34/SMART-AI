import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import type { ToolAdapter, ToolInput, ToolResult } from './types.js';

type QmdSearchItem = {
  docid?: string;
  score?: number;
  file?: string;
  title?: string;
  snippet?: string;
};

type QmdExecResult = {
  stdout: string;
  stderr: string;
};

type QmdRunner = (args: string[]) => Promise<QmdExecResult>;

const execFileAsync = promisify(execFile);
const initializedCollections = new Set<string>();

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseQmdSearchJson(raw: string): QmdSearchItem[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as QmdSearchItem[]) : [];
  } catch {
    return [];
  }
}

function formatItems(items: QmdSearchItem[], maxSnippetChars: number): { summary: string; citations: string[] } {
  const lines: string[] = [];
  const citations: string[] = [];

  for (const [index, item] of items.entries()) {
    const title = truncate(item.title || item.file || 'Untitled', 120);
    const file = item.file ? truncate(item.file, 160) : 'unknown';
    const score = typeof item.score === 'number' ? item.score.toFixed(3) : 'n/a';
    const snippet = item.snippet ? truncate(item.snippet, maxSnippetChars) : 'snippet yok';

    lines.push(`${index + 1}. [${title}] score=${score}\nKaynak: ${file}\n${snippet}`);

    if (item.file) {
      citations.push(item.file);
    }
  }

  return {
    summary: lines.join('\n\n'),
    citations: [...new Set(citations)]
  };
}

async function defaultQmdRunner(args: string[]): Promise<QmdExecResult> {
  const { stdout, stderr } = await execFileAsync(config.tools.qmdCommand, args, {
    timeout: config.tools.qmdTimeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf-8'
  });

  return {
    stdout: stdout || '',
    stderr: stderr || ''
  };
}

async function ensureCollection(
  runner: QmdRunner,
  opts: {
    collectionName: string;
    collectionPath: string;
    autoAdd: boolean;
  }
): Promise<void> {
  const cacheKey = `${opts.collectionName}|${opts.collectionPath}`;
  if (initializedCollections.has(cacheKey)) return;

  const listed = await runner(['collection', 'list']);
  const haystack = `${listed.stdout}\n${listed.stderr}`.toLowerCase();
  const collectionDetected =
    haystack.includes(opts.collectionName.toLowerCase()) || haystack.includes(opts.collectionPath.toLowerCase());

  if (!collectionDetected && opts.autoAdd) {
    try {
      await runner(['collection', 'add', opts.collectionPath, '--name', opts.collectionName]);
    } catch (error) {
      const msg = toMessage(error).toLowerCase();
      if (!msg.includes('already exists') && !msg.includes('duplicate')) {
        throw error;
      }
    }
  }

  initializedCollections.add(cacheKey);
}

async function executeQmdSearchWithRunner(
  input: ToolInput,
  runner: QmdRunner,
  opts: {
    enabled: boolean;
    collectionName: string;
    collectionPath: string;
    autoAddCollection: boolean;
    maxResults: number;
    maxSnippetChars: number;
  }
): Promise<ToolResult> {
  if (!opts.enabled) {
    return {
      tool: 'qmd_search',
      summary: 'QMD search devre dışı (QMD_ENABLED=false).',
      citations: []
    };
  }

  await ensureCollection(runner, {
    collectionName: opts.collectionName,
    collectionPath: opts.collectionPath,
    autoAdd: opts.autoAddCollection
  });

  const args = [
    'search',
    input.query,
    '--json',
    '-n',
    String(Math.max(1, Math.min(opts.maxResults, 20))),
    '-c',
    opts.collectionName
  ];

  const searchResult = await runner(args);
  const items = parseQmdSearchJson(searchResult.stdout).slice(0, opts.maxResults);

  if (items.length === 0) {
    return {
      tool: 'qmd_search',
      summary: `QMD local aramada sonuç bulunamadı (${opts.collectionName}).`,
      citations: [],
      raw: {
        provider: 'qmd',
        collection: opts.collectionName,
        stdout: truncate(searchResult.stdout, 600),
        stderr: truncate(searchResult.stderr, 300)
      }
    };
  }

  const formatted = formatItems(items, opts.maxSnippetChars);

  return {
    tool: 'qmd_search',
    summary: formatted.summary,
    citations: formatted.citations,
    raw: {
      provider: 'qmd',
      collection: opts.collectionName,
      total: items.length,
      items
    }
  };
}

export const qmdSearchTool: ToolAdapter = {
  name: 'qmd_search',
  async execute(input: ToolInput): Promise<ToolResult> {
    return executeQmdSearchWithRunner(input, defaultQmdRunner, {
      enabled: config.tools.qmdEnabled,
      collectionName: config.tools.qmdCollectionName,
      collectionPath: config.tools.qmdCollectionPath,
      autoAddCollection: config.tools.qmdCollectionAutoAdd,
      maxResults: config.tools.qmdMaxResults,
      maxSnippetChars: config.tools.qmdMaxSnippetChars
    });
  }
};

export const __private__ = {
  parseQmdSearchJson,
  formatItems,
  executeQmdSearchWithRunner,
  ensureCollection,
  truncate
};
