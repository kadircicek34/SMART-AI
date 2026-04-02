import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.js';
import { inspectRemoteTextSource, RemoteUrlError } from '../../rag/remote-url.js';

const originalRemoteFetchMaxBytes = config.rag.remoteFetchMaxBytes;
const originalRemoteFetchMaxRedirects = config.rag.remoteFetchMaxRedirects;
const originalRemoteAllowedPorts = [...config.rag.remoteAllowedPorts];
const originalRemoteAllowedContentTypes = [...config.rag.remoteAllowedContentTypes];

beforeEach(() => {
  config.rag.remoteFetchMaxBytes = 8_192;
  config.rag.remoteFetchMaxRedirects = 2;
  config.rag.remoteAllowedPorts = [80, 443];
  config.rag.remoteAllowedContentTypes = ['text/*', 'application/json', 'application/xml', 'text/xml'];
});

afterEach(() => {
  config.rag.remoteFetchMaxBytes = originalRemoteFetchMaxBytes;
  config.rag.remoteFetchMaxRedirects = originalRemoteFetchMaxRedirects;
  config.rag.remoteAllowedPorts = [...originalRemoteAllowedPorts];
  config.rag.remoteAllowedContentTypes = [...originalRemoteAllowedContentTypes];
});

test('inspectRemoteTextSource previews text/html from a public remote URL', async () => {
  const preview = await inspectRemoteTextSource({
    url: 'https://93.184.216.34/docs',
    fetchImpl: (async () =>
      new Response('<html><title>Example Docs</title><body>SMART-AI preview text</body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8'
        }
      })) as typeof fetch
  });

  assert.equal(preview.finalUrl, 'https://93.184.216.34/docs');
  assert.equal(preview.title, 'Example Docs');
  assert.equal(preview.contentType, 'text/html');
  assert.match(preview.snippet, /SMART-AI preview text/i);
});

test('inspectRemoteTextSource pins the resolved public address when using the default transport path', async () => {
  let capturedRequest: any = null;

  const preview = await inspectRemoteTextSource({
    url: 'https://docs.example.com/guide',
    lookupImpl: (async () =>
      [
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 }
      ]) as any,
    requestImpl: async (request) => {
      capturedRequest = request;
      return {
        statusCode: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8'
        },
        bodyText: 'SMART-AI DNS pinning smoke test',
        byteCount: 32
      };
    }
  });

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.url.hostname, 'docs.example.com');
  assert.equal(capturedRequest.pinnedAddress.address, '93.184.216.34');
  assert.equal(capturedRequest.headers.accept, config.rag.remoteAllowedContentTypes.join(', '));
  assert.equal(preview.finalUrl, 'https://docs.example.com/guide');
  assert.equal(preview.contentLengthBytes, 32);
  assert.match(preview.snippet, /DNS pinning/i);
});

test('inspectRemoteTextSource rejects direct private-network and link-local targets before fetch', async () => {
  await assert.rejects(
    () =>
      inspectRemoteTextSource({
        url: 'http://127.0.0.1/private',
        fetchImpl: (async () => {
          throw new Error('fetch should not be called');
        }) as typeof fetch
      }),
    (error: unknown) => error instanceof RemoteUrlError && error.code === 'remote_url_private_network_not_allowed'
  );

  await assert.rejects(
    () =>
      inspectRemoteTextSource({
        url: 'http://169.254.169.254/latest/meta-data',
        fetchImpl: (async () => {
          throw new Error('fetch should not be called');
        }) as typeof fetch
      }),
    (error: unknown) => error instanceof RemoteUrlError && error.code === 'remote_url_private_network_not_allowed'
  );
});

test('inspectRemoteTextSource rejects credentialed URLs before fetch', async () => {
  await assert.rejects(
    () =>
      inspectRemoteTextSource({
        url: 'https://user:secret@93.184.216.34/private',
        fetchImpl: (async () => {
          throw new Error('fetch should not be called');
        }) as typeof fetch
      }),
    (error: unknown) => error instanceof RemoteUrlError && error.code === 'remote_url_credentials_not_allowed'
  );
});

test('inspectRemoteTextSource revalidates redirect targets and blocks private-network hops', async () => {
  let callCount = 0;

  await assert.rejects(
    () =>
      inspectRemoteTextSource({
        url: 'https://93.184.216.34/start',
        fetchImpl: (async () => {
          callCount += 1;
          return new Response(null, {
            status: 302,
            headers: {
              location: 'http://127.0.0.1/admin'
            }
          });
        }) as typeof fetch
      }),
    (error: unknown) => error instanceof RemoteUrlError && error.code === 'remote_url_private_network_not_allowed'
  );

  assert.equal(callCount, 1);
});

test('inspectRemoteTextSource rejects disallowed content types and oversized responses', async () => {
  await assert.rejects(
    () =>
      inspectRemoteTextSource({
        url: 'https://93.184.216.34/archive',
        fetchImpl: (async () =>
          new Response('binary payload', {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream'
            }
          })) as typeof fetch
      }),
    (error: unknown) => error instanceof RemoteUrlError && error.code === 'remote_url_content_type_not_allowed'
  );

  await assert.rejects(
    () =>
      inspectRemoteTextSource({
        url: 'https://93.184.216.34/large',
        fetchImpl: (async () =>
          new Response('x'.repeat(32), {
            status: 200,
            headers: {
              'content-type': 'text/plain',
              'content-length': '999999'
            }
          })) as typeof fetch
      }),
    (error: unknown) => error instanceof RemoteUrlError && error.code === 'remote_url_response_too_large'
  );
});
