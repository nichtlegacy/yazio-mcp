import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, orderedRange, toApiDateTime, today } from '../src/dates.js';
import { buildDiary, summarize, type Product, type Recipe } from '../src/diary.js';
import { YazioClient, YazioError, describeError } from '../src/yazio.js';

test('dates', () => {
  const now = new Date(2026, 8, 29, 14, 5, 9);
  assert.equal(today(now), '2026-09-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(toApiDateTime('2026-09-29', undefined, 'lunch', now), '2026-09-29 14:05:09');
  assert.equal(toApiDateTime('2026-09-20', undefined, 'dinner', now), '2026-09-20 19:00:00');
  assert.equal(toApiDateTime('2026-09-20', undefined, undefined, now), '2026-09-20 12:00:00');
  assert.equal(toApiDateTime('2026-09-20', '07:30', 'dinner', now), '2026-09-20 07:30:00');
  assert.deepEqual(orderedRange('2026-09-10', '2026-09-01'), ['2026-09-01', '2026-09-10']);
});

test('diary: nutrients per unit, per portion and absolute', () => {
  // Verified live: 330 ml of a 0.2 kcal/ml product = 66 kcal, protein 0.046 g/ml = 15.18 g.
  const cola: Product = {
    name: 'Cola Lemon',
    base_unit: 'ml',
    nutrients: { 'energy.energy': 0.2, 'nutrient.protein': 0.046 },
  };
  const wrap: Recipe = {
    name: 'Mais Wrap',
    portion_count: 2,
    nutrients: { 'energy.energy': 760.775, 'nutrient.fat': 46.572 },
  };
  const diary = buildDiary(
    {
      products: [
        {
          id: 'p1',
          date: '2026-09-23 16:00:59',
          daytime: 'lunch',
          product_id: 'cola',
          amount: 330,
          serving: 'glass',
          serving_quantity: 1,
        },
        {
          id: 'p2',
          date: '2026-09-23 09:00:00',
          daytime: 'breakfast',
          product_id: 'gone',
          amount: 50,
          serving: null,
          serving_quantity: null,
        },
      ],
      recipe_portions: [
        {
          id: 'r1',
          date: '2026-09-23 13:41:05',
          daytime: 'lunch',
          recipe_id: 'wrap',
          portion_count: 1,
        },
      ],
      simple_products: [
        {
          id: 's1',
          date: '2026-09-23 11:42:49',
          daytime: 'breakfast',
          name: 'Brötchen',
          nutrients: { 'energy.energy': 478, 'nutrient.protein': 20 },
          is_ai_generated: true,
        },
      ],
    },
    new Map([
      ['cola', cola],
      ['gone', null],
    ]),
    new Map([['wrap', wrap]])
  );

  assert.deepEqual(
    diary.meals.lunch.entries.map((e) => e.id),
    ['r1', 'p1']
  );
  assert.deepEqual(diary.meals.lunch.entries[1].nutrients, { kcal: 66, protein_g: 15.18 });
  assert.deepEqual(diary.meals.lunch.entries[0].nutrients, { kcal: 760.78, fat_g: 46.57 });
  assert.equal(diary.meals.breakfast.entries[0].name, 'Unknown product');
  assert.equal(diary.meals.breakfast.entries[0].nutrients, null);
  assert.equal(diary.meals.breakfast.entries[1].type, 'quick_entry');
  assert.deepEqual(diary.meals.dinner, { entries: [], totals: {} });
  assert.deepEqual(diary.totals, { kcal: 1304.78, protein_g: 35.18, fat_g: 46.57 });
  assert.deepEqual(summarize({ 'energy.energy': 0.63, 'mineral.iron': 1 }, 100), { kcal: 63 });
});

function fakeFetch(handler: (url: URL, init: RequestInit) => [number, unknown]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const [status, body] = handler(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

const grant = (n: number, expiresIn = 172800) => ({
  access_token: `access${n}`,
  refresh_token: `refresh${n}`,
  expires_in: expiresIn,
  token_type: 'bearer',
});

test('client: logs in once, reuses the token and shares concurrent logins', async () => {
  let logins = 0;
  const api = fakeFetch((url) => {
    if (url.pathname === '/v18/oauth/token') return [200, grant(++logins)];
    return [200, { ok: true }];
  });
  const client = new YazioClient({ username: 'u', password: 'p', fetch: api.fn });
  await Promise.all([client.get('/user'), client.get('/user/settings')]);
  await client.get('/user', { date: '2026-09-29', skip: undefined });
  assert.equal(logins, 1);
  const last = api.calls.at(-1)!;
  assert.equal(last.url.search, '?date=2026-09-29');
  assert.equal((last.init.headers as Record<string, string>).Authorization, 'Bearer access1');
});

test('client: re-authenticates once on 401', async () => {
  let logins = 0;
  const api = fakeFetch((url, init) => {
    if (url.pathname.endsWith('/oauth/token')) return [200, grant(++logins)];
    const auth = (init.headers as Record<string, string>).Authorization;
    return auth === 'Bearer access1'
      ? [401, { message: 'Invalid credentials.' }]
      : [200, { ok: 1 }];
  });
  const client = new YazioClient({ username: 'u', password: 'p', fetch: api.fn });
  assert.deepEqual(await client.get('/user'), { ok: 1 });
  assert.equal(logins, 2);
});

test('client: refreshes an expired token, falls back to password grant', async () => {
  const grants: string[] = [];
  let refreshWorks = true;
  const api = fakeFetch((url, init) => {
    if (url.pathname.endsWith('/oauth/token')) {
      const body = JSON.parse(String(init.body));
      grants.push(body.grant_type);
      if (body.grant_type === 'refresh_token' && !refreshWorks)
        return [400, { error: 'invalid_grant' }];
      // Expires immediately, so every request needs a new grant.
      return [200, grant(grants.length, 0)];
    }
    return [200, {}];
  });
  const client = new YazioClient({ username: 'u', password: 'p', fetch: api.fn });
  await client.get('/user');
  await client.get('/user');
  refreshWorks = false;
  await client.get('/user');
  assert.deepEqual(grants, ['password', 'refresh_token', 'refresh_token', 'password']);
});

test('client: readable errors', async () => {
  const api = fakeFetch((url) => {
    if (url.pathname.endsWith('/oauth/token')) return [200, grant(1)];
    if (url.pathname.endsWith('/blocked')) return [403, { error: 'version_blocked' }];
    return [400, [{ property_path: 'date', message: 'This value is not a valid date.' }]];
  });
  const client = new YazioClient({ username: 'u', password: 'p', fetch: api.fn });
  await assert.rejects(client.get('/user/goals'), (e: YazioError) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /GET \/user\/goals failed: date: This value is not a valid date\./);
    return true;
  });
  await assert.rejects(client.get('/blocked'), /version_blocked/);
  assert.match(describeError(404, null), /not found/);

  const badLogin = fakeFetch(() => [400, [{ message: 'bad' }]]);
  await assert.rejects(
    new YazioClient({ username: 'u', password: 'p', fetch: badLogin.fn }).get('/user'),
    /check YAZIO_USERNAME and YAZIO_PASSWORD/
  );
});
