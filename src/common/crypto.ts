import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

export const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export const hmacHex = (
  algorithm: 'sha256' | 'sha512',
  secret: string,
  payload: string | Buffer,
) => createHmac(algorithm, secret).update(payload).digest('hex');

/** Constant-time comparison of two hex/ascii strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const token = (bytes: number) => randomBytes(bytes).toString('base64url');

/** API key an app sends as `Authorization: Bearer ...`. */
export const newApiKey = (appId: string) => `ak_${appId}_${token(32)}`;

/** Secret used to sign events forwarded to an app. */
export const newWebhookSecret = () => `whsec_${token(32)}`;

/**
 * AES-256-GCM for card authorization codes at rest. The key is 32 bytes,
 * base64-encoded, from CARD_ENCRYPTION_KEY. Output: iv.tag.ciphertext.
 */
export class Cipher {
  private readonly key: Buffer;

  constructor(base64Key: string | undefined) {
    const key = Buffer.from(base64Key ?? '', 'base64');
    if (key.length !== 32) {
      throw new Error(
        'CARD_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)',
      );
    }
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString('base64url'))
      .join('.');
  }

  decrypt(sealed: string): string {
    const [iv, tag, data] = sealed
      .split('.')
      .map((p) => Buffer.from(p, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }
}
