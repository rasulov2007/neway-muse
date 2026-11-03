import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { HealthResponseSchema, ProblemDetailsSchema, REQUEST_ID_HEADER } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';

describe('API foundation (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));

    const body = HealthResponseSchema.parse(response.json());
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('unknown route returns a problem+json 404 carrying the request id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
      headers: { [REQUEST_ID_HEADER]: 'e2e-request-123' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers[REQUEST_ID_HEADER]).toBe('e2e-request-123');

    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.status).toBe(404);
    expect(problem.title).toBe('Not Found');
    expect(problem.instance).toBe('/api/v1/does-not-exist');
    expect(problem.requestId).toBe('e2e-request-123');
  });

  it('generates a request id when the client does not send one', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/missing' });

    expect(response.statusCode).toBe(404);
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(problem.requestId);
  });
});
