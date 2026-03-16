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
