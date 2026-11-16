/** Typed configuration read once from the environment. */
export interface PayConfig {
  port: number;
  paystackSecretKey: string;
  paystackBaseUrl: string;
  cardEncryptionKey: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PayConfig {
  const missing = [
    'DATABASE_URL',
    'PAYSTACK_SECRET_KEY',
    'CARD_ENCRYPTION_KEY',
  ].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
  return {
    port: Number(env.PORT ?? 4500),
    paystackSecretKey: env.PAYSTACK_SECRET_KEY!,
    paystackBaseUrl: (
      env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co'
    ).replace(/\/$/, ''),
    cardEncryptionKey: env.CARD_ENCRYPTION_KEY!,
  };
}

export const PAY_CONFIG = Symbol('PAY_CONFIG');
