import crypto from 'node:crypto';
import { config } from '../config.js';
import { collectTenantMemories, readOnlyMemoryStore, withMemoryStore } from './store.js';
import type {
  MemoryCategory,
  MemoryItemInput,
  MemoryItemRecord,
  MemorySearchDecision,
  MemorySearchHit,
  MemoryStorePayload
} from './types.js';

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'at',
  'is',
  'are',
  'be',
  'with',
  'as',
  'by',
  'from',
  'that',
  'this',
  'it',
  'its',
  'into',
  'about',
  'we',
  'you',
  'your',
  'our',
  'their',
  'they',
  'he',
  'she',
  'them',
  've',
  'de',
  'da',
  'bir',
  'veya',
  'ile',
  'için',
  'olarak',
  'bu',
  'şu',
  'o',
  'mi',
  'mı',
  'mu',
  'mü',
  'çok',
  'az',
  'daha',
  'en',
  'gibi',
  'ama',
  'fakat',
  'ancak',
  've',
  'ya',
  'yada',
  'biz',
  'siz',
  'ben'
]);

const MEMORY_RETRIEVE_HINT =
  /\b(remember|recall|previous|past|before|earlier|history|last time|hatırla|hatırlıyor|önceki|geçen|daha önce|tercih|alışkanlık|profilim|hakkımda|not al|memory|hafıza|geçmişte|benim)\b/i;

const NO_RETRIEVE_HINT = /^(selam|merhaba|hi|hello|hey|teşekkür|thanks|okey|okay|tamam|good morning|good night)[!.?\s]*$/i;

const PROFILE_HINT = /\b(adım|yaşım|mesleğim|i am|i'm|ben\s+bir|my name|kimliğim|profil)\b/i;
const PREFERENCE_HINT = /\b(severim|seviyorum|sevmem|prefer|favorite|tercih|favori|hoşlanırım)\b/i;
const HABIT_HINT = /\b(her gün|genelde|alışkan|routine|rutin|çoğunlukla)\b/i;
const GOAL_HINT = /\b(hedef|goal|amaç|planlıyorum|planım|istiyorum)\b/i;
const TODO_HINT = /\b(todo|yapılacak|hatırlat|remind|yapmam gerek|unutma)\b/i;
const RELATION_HINT = /\b(annem|babam|eşim|arkadaşım|takımım|müşterim|partnerim|relationship)\b/i;
const EVENT_HINT = /\b(dün|bugün|yarın|toplantı|meeting|olay|event|yaşadım|gerçekleşti)\b/i;
const KNOWLEDGE_HINT = /\b(biliyorum|öğrendim|not düş|knowledge|özetle)\b/i;

const MAX_MEMORY_CONTENT_CHARS = 10_000;
const MAX_MEMORY_BATCH = 30;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9ğüşöçıİĞÜŞÖÇ]+/gi) ?? [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1)
    .filter((token) => !STOP_WORDS.has(token));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ensureTenantIsolation(tenantId: string) {
  if (!tenantId.trim()) {
    throw new Error('tenant_id_required');
  }
}

function inferMemoryCategory(content: string): MemoryCategory {
  if (PROFILE_HINT.test(content)) return 'profile';
  if (PREFERENCE_HINT.test(content)) return 'preference';
  if (HABIT_HINT.test(content)) return 'habit';
  if (GOAL_HINT.test(content)) return 'goal';
  if (TODO_HINT.test(content)) return 'todo';
  if (RELATION_HINT.test(content)) return 'relationship';
  if (EVENT_HINT.test(content)) return 'event';
  if (KNOWLEDGE_HINT.test(content)) return 'knowledge';
  return config.memory.defaultCategory;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.map((tag) => normalizeWhitespace(tag).slice(0, 60)).filter(Boolean))].slice(0, 15);
}

function normalizeCategory(category: string | undefined, content: string): MemoryCategory {
  if (!category) return inferMemoryCategory(content);

  const normalized = category.trim().toLowerCase();
  const allowed: MemoryCategory[] = [
    'profile',
    'preference',
    'habit',
    'goal',
    'todo',
    'event',
    'knowledge',
    'relationship',
    'note'
  ];

  if (allowed.includes(normalized as MemoryCategory)) {
    return normalized as MemoryCategory;
  }

  return inferMemoryCategory(content);
}

function buildIdf(items: MemoryItemRecord[], queryTokens: string[]): Map<string, number> {
  const idf = new Map<string, number>();
  const n = items.length;

  for (const token of new Set(queryTokens)) {
    let df = 0;
    for (const item of items) {
      if (item.tokens.includes(token)) df += 1;
    }

    idf.set(token, Math.log((n + 1) / (df + 1)) + 1);
  }

  return idf;
}

function queryWantsPreference(query: string): boolean {
  return /\b(prefer|favorite|tercih|seviyor|sever|hoşlan)\b/i.test(query);
}

function queryWantsProfile(query: string): boolean {
  return /\b(kimim|hakkımda|profil|my profile|about me|ben kim)\b/i.test(query);
}

function queryWantsTodo(query: string): boolean {
  return /\b(todo|hatırlat|yapılacak|next task|görev)\b/i.test(query);
}

function computeMemoryScore(params: {
  item: MemoryItemRecord;
  queryTokens: string[];
  queryRaw: string;
  idf: Map<string, number>;
}): number {
  const { item, queryTokens, queryRaw, idf } = params;
  if (queryTokens.length === 0 || item.tokens.length === 0) return 0;

  const frequency = new Map<string, number>();
  for (const token of item.tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  let rawScore = 0;
  const queryUnique = new Set(queryTokens);
  const matched = new Set<string>();

  for (const token of queryTokens) {
    const tf = (frequency.get(token) ?? 0) / item.tokens.length;
    if (tf > 0) matched.add(token);
    rawScore += tf * (idf.get(token) ?? 1);
  }

  const coverageBoost = queryUnique.size > 0 ? (matched.size / queryUnique.size) * 0.25 : 0;
  const phraseBoost = item.content.toLowerCase().includes(queryRaw.toLowerCase()) ? 0.2 : 0;

  const ageDays = Math.max(0, (Date.now() - item.updatedAt) / 86_400_000);
  const recencyBoost = Math.max(0, 0.2 - ageDays * 0.01);
  const salienceBoost = clamp(item.salience, 0, 1) * 0.2;

  let categoryBoost = 0;
  if (queryWantsPreference(queryRaw) && item.category === 'preference') categoryBoost += 0.18;
  if (queryWantsProfile(queryRaw) && item.category === 'profile') categoryBoost += 0.18;
  if (queryWantsTodo(queryRaw) && item.category === 'todo') categoryBoost += 0.18;

  return rawScore + coverageBoost + phraseBoost + recencyBoost + salienceBoost + categoryBoost;
}

export function decideMemoryRetrieval(params: {
  query: string;
  conversationContext?: string[];
}): MemorySearchDecision {
  const query = normalizeWhitespace(params.query);
  if (!query) {
    return {
      decision: 'NO_RETRIEVE',
      rewrittenQuery: query,
      reason: 'empty_query'
    };
  }

  if (NO_RETRIEVE_HINT.test(query)) {
    return {
      decision: 'NO_RETRIEVE',
      rewrittenQuery: query,
      reason: 'small_talk_or_ack'
    };
  }

  const hasMemoryHint = MEMORY_RETRIEVE_HINT.test(query);
  const hasFirstPersonCue = /\b(i|my|me|ben|bana|benim|bizim)\b/i.test(query);

  if (!hasMemoryHint && !hasFirstPersonCue) {
    return {
      decision: 'NO_RETRIEVE',
      rewrittenQuery: query,
      reason: 'no_memory_signal'
    };
  }

  const context = (params.conversationContext ?? [])
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(-4);

  const rewrittenQuery =
    context.length > 0
      ? `${query}\n\nConversation context:\n${context.map((line, index) => `${index + 1}. ${line}`).join('\n')}`
      : query;

  return {
    decision: 'RETRIEVE',
    rewrittenQuery,
    reason: hasMemoryHint ? 'memory_signal_detected' : 'first_person_signal_detected'
  };
}

export async function memorizeForTenant(params: {
  tenantId: string;
  items: MemoryItemInput[];
}): Promise<{ memoryIds: string[]; stored: number; updated: number }> {
  const tenantId = params.tenantId.trim();
  ensureTenantIsolation(tenantId);

  if (params.items.length === 0) {
    throw new Error('memory_items_required');
  }

  if (params.items.length > MAX_MEMORY_BATCH) {
    throw new Error(`too_many_memory_items_max_${MAX_MEMORY_BATCH}`);
  }

  const prepared = params.items.map((item, index) => {
    const content = normalizeWhitespace(item.content);
    if (!content) {
      throw new Error(`memory_item_${index}_content_required`);
    }

    if (content.length > MAX_MEMORY_CONTENT_CHARS) {
      throw new Error(`memory_item_${index}_too_large_max_${MAX_MEMORY_CONTENT_CHARS}`);
    }

    return {
      memoryId: item.memoryId?.trim(),
      content,
      normalizedContent: content.toLowerCase(),
      category: normalizeCategory(item.category, content),
      tags: normalizeTags(item.tags),
      source: normalizeWhitespace(item.source ?? 'memory-api').slice(0, 120) || 'memory-api',
      salience: clamp(item.salience ?? 0.5, 0, 1),
      context: item.context ? normalizeWhitespace(item.context).slice(0, 4000) : undefined,
      tokens: tokenize(content)
    };
  });

  return withMemoryStore(async (store) => {
    const tenantItems = collectTenantMemories(store, tenantId);
    let updated = 0;
    let stored = 0;

    if (tenantItems.length + prepared.length > config.memory.maxItemsPerTenant + 100) {
      throw new Error(`tenant_memory_limit_exceeded_max_${config.memory.maxItemsPerTenant}`);
    }

    const now = Date.now();
    const memoryIds: string[] = [];

    for (const item of prepared) {
      const byContent = tenantItems.find((entry) => entry.normalizedContent === item.normalizedContent);
      const proposedId = item.memoryId || byContent?.memoryId || `mem_${crypto.randomUUID().replace(/-/g, '')}`;
      const existing = store.items[proposedId];

      if (existing && existing.tenantId !== tenantId) {
        throw new Error('memory_id_conflict_cross_tenant');
      }

      const nextRecord: MemoryItemRecord = {
        memoryId: proposedId,
        tenantId,
        content: item.content,
        normalizedContent: item.normalizedContent,
        category: item.category,
        tags: item.tags,
        source: item.source,
        salience: item.salience,
        context: item.context,
        tokens: item.tokens,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastRetrievedAt: existing?.lastRetrievedAt,
        retrievalCount: existing?.retrievalCount ?? 0
      };

      store.items[proposedId] = nextRecord;
      memoryIds.push(proposedId);

      if (existing) {
        updated += 1;
      } else {
        stored += 1;
      }
    }

    // Hard trim in case tenant exceeds configured max.
    const latestTenantItems = collectTenantMemories(store, tenantId).sort((a, b) => b.updatedAt - a.updatedAt);
    const overflow = Math.max(0, latestTenantItems.length - config.memory.maxItemsPerTenant);
    if (overflow > 0) {
      for (const item of latestTenantItems.slice(-overflow)) {
        delete store.items[item.memoryId];
      }
    }

    return {
      memoryIds,
      stored,
      updated
    };
  });
}

export async function searchTenantMemories(params: {
  tenantId: string;
  query: string;
  limit?: number;
  minScore?: number;
  categories?: MemoryCategory[];
  forceRetrieve?: boolean;
  conversationContext?: string[];
}): Promise<{ decision: MemorySearchDecision; hits: MemorySearchHit[] }> {
  const tenantId = params.tenantId.trim();
  ensureTenantIsolation(tenantId);

  const query = normalizeWhitespace(params.query);
  const decision = decideMemoryRetrieval({
    query,
    conversationContext: params.conversationContext
  });

  if (!params.forceRetrieve && decision.decision === 'NO_RETRIEVE') {
    return {
      decision,
      hits: []
    };
  }

  const queryTokens = tokenize(decision.rewrittenQuery || query);
  if (queryTokens.length === 0) {
    return {
      decision,
      hits: []
    };
  }

  return withMemoryStore(async (store) => {
    const limit = clamp(params.limit ?? 8, 1, 25);
    const minScore = params.minScore ?? 0.04;
    const categoryFilter = params.categories ? new Set(params.categories) : null;

    const scoped = collectTenantMemories(store, tenantId).filter((item) =>
      categoryFilter ? categoryFilter.has(item.category) : true
    );

    if (scoped.length === 0) {
      return {
        decision,
        hits: []
      };
    }

    const idf = buildIdf(scoped, queryTokens);
    const scored = scoped
      .map((item) => ({
        item,
        score: computeMemoryScore({ item, queryTokens, queryRaw: query, idf })
      }))
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const now = Date.now();
    for (const entry of scored) {
      const mutable = store.items[entry.item.memoryId];
      if (!mutable) continue;
      mutable.lastRetrievedAt = now;
      mutable.retrievalCount += 1;
    }

    return {
      decision,
      hits: scored.map(({ item, score }) => ({
        memoryId: item.memoryId,
        category: item.category,
        content: item.content,
        source: item.source,
        tags: item.tags,
        score: Number(score.toFixed(4)),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }))
    };
  });
}

export async function listTenantMemories(params: {
  tenantId: string;
  limit?: number;
  categories?: MemoryCategory[];
}): Promise<MemoryItemRecord[]> {
  const tenantId = params.tenantId.trim();
  ensureTenantIsolation(tenantId);

  return readOnlyMemoryStore(async (store) => {
    const limit = clamp(params.limit ?? 50, 1, 300);
    const categoryFilter = params.categories ? new Set(params.categories) : null;

    return collectTenantMemories(store, tenantId)
      .filter((item) => (categoryFilter ? categoryFilter.has(item.category) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  });
}

export async function deleteTenantMemory(params: {
  tenantId: string;
  memoryId: string;
}): Promise<{ removed: boolean }> {
  const tenantId = params.tenantId.trim();
  ensureTenantIsolation(tenantId);

  const memoryId = params.memoryId.trim();
  if (!memoryId) return { removed: false };

  return withMemoryStore(async (store) => {
    const item = store.items[memoryId];
    if (!item || item.tenantId !== tenantId) {
      return { removed: false };
    }

    delete store.items[memoryId];
    return { removed: true };
  });
}

export async function getTenantMemoryStats(tenantId: string): Promise<{ items: number; byCategory: Record<string, number> }> {
  const id = tenantId.trim();
  ensureTenantIsolation(id);

  return readOnlyMemoryStore(async (store: MemoryStorePayload) => {
    const items = collectTenantMemories(store, id);
    const byCategory: Record<string, number> = {};

    for (const item of items) {
      byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    }

    return {
      items: items.length,
      byCategory
    };
  });
}

function shouldAutoCapture(content: string): boolean {
  const normalized = normalizeWhitespace(content);
  if (!normalized) return false;
  if (normalized.length < 12 || normalized.length > MAX_MEMORY_CONTENT_CHARS) return false;
  if (NO_RETRIEVE_HINT.test(normalized)) return false;

  return (
    /\b(i|my|me|ben|benim|bana|bizim)\b/i.test(normalized) ||
    PROFILE_HINT.test(normalized) ||
    PREFERENCE_HINT.test(normalized) ||
    HABIT_HINT.test(normalized) ||
    GOAL_HINT.test(normalized) ||
    TODO_HINT.test(normalized)
  );
}

export async function autoCaptureUserMemory(params: {
  tenantId: string;
  message: string;
  source?: string;
}): Promise<{ captured: boolean; memoryId?: string; reason?: string }> {
  if (!config.memory.autoCaptureUserMessages) {
    return { captured: false, reason: 'auto_capture_disabled' };
  }

  const content = normalizeWhitespace(params.message);
  if (!shouldAutoCapture(content)) {
    return { captured: false, reason: 'message_not_memory_worthy' };
  }

  const result = await memorizeForTenant({
    tenantId: params.tenantId,
    items: [
      {
        content,
        category: inferMemoryCategory(content),
        source: params.source ?? 'chat-auto-capture',
        salience: 0.65
      }
    ]
  });

  return {
    captured: true,
    memoryId: result.memoryIds[0]
  };
}

export const __private__ = {
  tokenize,
  inferMemoryCategory,
  decideMemoryRetrieval,
  shouldAutoCapture,
  computeMemoryScore
};
