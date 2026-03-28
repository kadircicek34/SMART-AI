export type RagDocumentInput = {
  documentId?: string;
  title?: string;
  content: string;
  source?: string;
};

export type RagDocumentRecord = {
  documentId: string;
  tenantId: string;
  title: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  chunkIds: string[];
};

export type RagChunkRecord = {
  chunkId: string;
  documentId: string;
  tenantId: string;
  title: string;
  source: string;
  text: string;
  tokens: string[];
  createdAt: number;
};

export type RagStorePayload = {
  documents: Record<string, RagDocumentRecord>;
  chunks: Record<string, RagChunkRecord>;
};

export type RagSearchHit = {
  documentId: string;
  chunkId: string;
  title: string;
  source: string;
  content: string;
  score: number;
};

export type RagRemotePolicyDecision = {
  source: 'deployment' | 'tenant';
  mode: 'disabled' | 'preview_only' | 'allowlist_only' | 'open';
  hostname: string;
  allowedForPreview: boolean;
  allowedForIngest: boolean;
  matchedHostRule: string | null;
  reason: 'policy_disabled' | 'preview_only_mode' | 'allowlist_match' | 'host_not_in_allowlist' | 'open_mode';
};

export type RagRemoteUrlMetadata = {
  normalizedUrl: string;
  finalUrl: string;
  redirects: string[];
  statusCode: number;
  contentType: string;
  contentLengthBytes: number;
  excerpt: string;
  excerptTruncated: boolean;
  policy: RagRemotePolicyDecision;
};

export type RagRemoteUrlPreview = RagRemoteUrlMetadata & {
  title?: string;
};
