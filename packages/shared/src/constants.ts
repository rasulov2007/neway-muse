/** Global route prefix of the HTTP API (no leading/trailing slash). */
export const API_PREFIX = 'api/v1';

/** Header carrying the correlation id of a request; echoed back on every response. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Media type of RFC 7807 problem details responses. */
export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';
