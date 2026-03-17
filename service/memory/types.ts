export type MemoryCategory =
  | 'profile'
  | 'preference'
  | 'habit'
  | 'goal'
  | 'todo'
  | 'event'
  | 'knowledge'
  | 'relationship'
  | 'note';

export type MemoryItemInput = {
  memoryId?: string;
  content: string;
  category?: MemoryCategory;
  tags?: string[];
  source?: string;
  salience?: number;
  context?: string;
};

export type MemoryItemRecord = {
  memoryId: string;
  tenantId: string;
  content: string;
  normalizedContent: string;
  category: MemoryCategory;
  tags: string[];
  source: string;
  salience: number;
  context?: string;
  tokens: string[];
  relatedMemoryIds?: string[];
  createdAt: number;
  updatedAt: number;
  lastRetrievedAt?: number;
  retrievalCount: number;
};

export type MemoryRetrievalMetrics = {
  totalQueries: number;
  totalResults: number;
  zeroResultQueries: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  decisions: {
    RETRIEVE: number;
    NO_RETRIEVE: number;
  };
};

export type MemoryStorePayload = {
  items: Record<string, MemoryItemRecord>;
  tenantMetrics: Record<string, MemoryRetrievalMetrics>;
};

export type MemorySearchDecision = {
  decision: 'RETRIEVE' | 'NO_RETRIEVE';
  rewrittenQuery: string;
  reason: string;
};

export type MemorySearchHit = {
  memoryId: string;
  category: MemoryCategory;
  content: string;
  source: string;
  tags: string[];
  score: number;
  relatedMemoryIds?: string[];
  createdAt: number;
  updatedAt: number;
};
