import { randomBytes } from 'crypto';
import { Cipher, hmacHex, newApiKey, safeEqual, sha256 } from './common/crypto';
import { matchPrefix } from './apps/apps.service';
import { metadataApp } from './webhooks/webhooks.service';
import { PaystackClient } from './paystack/paystack.client';
import { PaymentsService } from './payments/payments.service';

const key = randomBytes(32).toString('base64');

describe('Cipher', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const c = new Cipher(key);
    const a = c.encrypt('AUTH_abc123');
    const b = c.encrypt('AUTH_abc123');
    expect(a).not.toBe(b);
    expect(c.decrypt(a)).toBe('AUTH_abc123');
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const c = new Cipher(key);
    const sealed = c.encrypt('AUTH_abc123');
    const [iv, tag, data] = sealed.split('.');
    const flipped = `${iv}.${tag}.${data.slice(0, -2)}${data.endsWith('A') ? 'B' : 'A'}${data.slice(-1)}`;
    expect(() => c.decrypt(flipped)).toThrow();
    expect(() =>
      new Cipher(randomBytes(32).toString('base64')).decrypt(sealed),
    ).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(() => new Cipher('short')).toThrow('CARD_ENCRYPTION_KEY');
  });
});

describe('keys and signatures', () => {
  it('makes app-scoped API keys', () => {
    expect(newApiKey('grow')).toMatch(/^ak_grow_[A-Za-z0-9_-]{43}$/);
    expect(sha256('x')).toHaveLength(64);
  });

  it('verifies Paystack signatures over the exact body', () => {
    const client = new PaystackClient({
      paystackSecretKey: 'sk_test',
      paystackBaseUrl: '',
      port: 0,
      cardEncryptionKey: key,
    });
    const body = '{"event":"charge.success"}';
    const sig = hmacHex('sha512', 'sk_test', body);
    expect(client.verifySignature(body, sig)).toBe(true);
    expect(client.verifySignature(body + ' ', sig)).toBe(false);
    expect(client.verifySignature(body, undefined)).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('routing helpers', () => {
  const apps = [
    { id: 'dali', referencePrefixes: ['DALI-'] },
    { id: 'dali-payouts', referencePrefixes: ['DALI-P-'] },
    { id: 'grow', referencePrefixes: ['GROW-', 'MEMBERSHIP'] },
  ];

  it('picks the longest matching prefix', () => {
    expect(matchPrefix(apps, 'DALI-E-123')?.id).toBe('dali');
    expect(matchPrefix(apps, 'DALI-P-123')?.id).toBe('dali-payouts');
    expect(matchPrefix(apps, 'MEMBERSHIP-RENEW.1')?.id).toBe('grow');
    expect(matchPrefix(apps, 'OTHER-1')).toBeNull();
  });

  it('reads metadata.app from objects and JSON strings', () => {
    expect(metadataApp({ app: 'grow' })).toBe('grow');
    expect(metadataApp('{"app":"dali"}')).toBe('dali');
    expect(metadataApp('not json')).toBeNull();
    expect(metadataApp(null)).toBeNull();
  });
});

describe('PaymentsService.applyResult', () => {
  const base = {
    id: 'p1',
    appId: 'grow',
    reference: 'GROW-1',
    kind: 'CHECKOUT',
    status: 'PENDING',
    email: 'a@b.c',
    customerId: 'u1',
    amount: 225000,
    currency: 'NGN',
    metadata: null,
    saveCard: true,
    cardId: null,
  };

  function setup(initial: Record<string, unknown> = {}) {
    let row: Record<string, unknown> = { ...base, ...initial };
    const cards: Record<string, unknown>[] = [];
    const prisma = {
      payment: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (row.status === 'SUCCESS' && where.status?.not === 'SUCCESS')
            return { count: 0 };
          row = { ...row, ...data };
          return { count: 1 };
        }),
        findUniqueOrThrow: jest.fn(async () => row),
        update: jest.fn(async ({ data }: any) => (row = { ...row, ...data })),
      },
      card: {
        upsert: jest.fn(async ({ create }: any) => {
          const c = { id: 'c1', ...create };
          cards.push(c);
          return c;
        }),
      },
    };
    const svc = new PaymentsService(prisma as any, {} as any, new Cipher(key));
    return { svc, prisma, cards, row: () => row };
  }

  const success = (over: Record<string, unknown> = {}) => ({
    status: 'success',
    amount: 225000,
    currency: 'NGN',
    authorization: {
      authorization_code: 'AUTH_x',
      reusable: true,
      signature: 'SIG_1',
      last4: '4081',
      brand: 'visa',
    },
    ...over,
  });

  it('marks success once and saves the reusable card encrypted', async () => {
    const { svc, cards, row } = setup();
    await svc.applyResult(row() as any, success());
    expect(row()).toMatchObject({ status: 'SUCCESS', cardId: 'c1' });
    expect(cards).toHaveLength(1);
    expect(cards[0].authorizationEncrypted).not.toContain('AUTH_x');
    expect(
      new Cipher(key).decrypt(cards[0].authorizationEncrypted as string),
    ).toBe('AUTH_x');
  });

  it('fails an underpaid or wrong-currency charge', async () => {
    const { svc, row } = setup();
    await svc.applyResult(row() as any, success({ amount: 1000 }));
    expect(row()).toMatchObject({
      status: 'FAILED',
      gatewayResponse: 'amount_mismatch',
    });
  });

  it('never moves a successful payment back', async () => {
    const { svc, prisma, row } = setup({ status: 'SUCCESS' });
    const out = await svc.applyResult(row() as any, { status: 'failed' });
    expect(out.status).toBe('SUCCESS');
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it('does not save non-reusable cards', async () => {
    const { svc, cards, row } = setup();
    await svc.applyResult(
      row() as any,
      success({
        authorization: { authorization_code: 'AUTH_x', reusable: false },
      }),
    );
    expect(row().status).toBe('SUCCESS');
    expect(cards).toHaveLength(0);
  });
});
