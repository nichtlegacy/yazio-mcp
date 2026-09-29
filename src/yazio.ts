// Minimal client for YAZIO's private mobile API.
// The API contract (endpoints, payloads, quirks) was verified live against a real
// account; see README "API notes". Nothing here is an official, stable API.

const CLIENT_ID = '1_4hiybetvfksgw40o0sog4s884kwc840wwso8go4k8c04goo4c';
const CLIENT_SECRET = '6rok2m65xuskgkgogw40wkkk8sw0osg84s8cggsc4woos4s8o';
// Refresh a bit early so a token never expires between check and request.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface YazioClientOptions {
  username: string;
  password: string;
  // v15–v19 answer without an app User-Agent; v20+ answer 403 version_blocked
  // unless an app User-Agent is sent. Payloads are identical, so v18 is the default.
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | undefined>;

interface Token {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class YazioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = 'YazioError';
  }
}

export class YazioClient {
  private token: Token | null = null;
  private authenticating: Promise<Token> | null = null;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: YazioClientOptions) {
    this.baseUrl = `${options.baseUrl ?? 'https://yzapi.yazio.com'}/${options.apiVersion ?? 'v18'}`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, { body });
  }

  async request<T>(
    method: string,
    path: string,
    init: { query?: Query; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const send = async (token: Token) =>
      this.fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token.accessToken}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });

    let response = await send(await this.getToken());
    if (response.status === 401) {
      // Token was revoked or expired early: authenticate from scratch once.
      this.token = null;
      response = await send(await this.getToken());
    }
    return parseResponse<T>(response, `${method} ${path}`);
  }

  private getToken(): Promise<Token> {
    if (this.token && this.token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return Promise.resolve(this.token);
    }
    // Share one in-flight authentication between concurrent requests.
    this.authenticating ??= this.authenticate().finally(() => {
      this.authenticating = null;
    });
    return this.authenticating;
  }

  private async authenticate(): Promise<Token> {
    if (this.token) {
      try {
        return (this.token = await this.grant({
          grant_type: 'refresh_token',
          refresh_token: this.token.refreshToken,
        }));
      } catch {
        // Refresh token expired or was rotated elsewhere: fall back to the password grant.
      }
    }
    return (this.token = await this.grant({
      grant_type: 'password',
      username: this.options.username,
      password: this.options.password,
    }));
  }

  private async grant(params: Record<string, string>): Promise<Token> {
    const response = await this.fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
    });
    if (response.status === 400 && params.grant_type === 'password') {
      throw new YazioError(
        'YAZIO login failed: check YAZIO_USERNAME and YAZIO_PASSWORD',
        400,
        null
      );
    }
    const data = await parseResponse<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>(response, 'POST /oauth/token');
    // YAZIO rotates both tokens on every grant, so both are replaced.
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }
}

async function parseResponse<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (response.ok) return body as T;
  throw new YazioError(
    `${label} failed: ${describeError(response.status, body)}`,
    response.status,
    body
  );
}

export function describeError(status: number, body: unknown): string {
  // Symfony validation errors arrive as an array, other errors as an object or null.
  if (Array.isArray(body) && body.length > 0) {
    return body
      .map(
        (e: { property_path?: string; message?: string }) =>
          `${e.property_path ?? '?'}: ${e.message ?? 'invalid'}`
      )
      .join('; ');
  }
  if (
    body &&
    typeof body === 'object' &&
    (body as { error?: string }).error === 'version_blocked'
  ) {
    return 'YAZIO blocked this API version (403 version_blocked). Set YAZIO_API_VERSION to another version, e.g. v18.';
  }
  if (status === 404) return 'not found (404)';
  if (status === 405) return 'not found (405, usually an invalid id)';
  if (status === 410) return 'API version removed by YAZIO (410)';
  const detail = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  return `HTTP ${status}${detail ? ` ${detail.slice(0, 300)}` : ''}`;
}
