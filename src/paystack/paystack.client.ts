import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PAY_CONFIG, PayConfig } from '../config';
import { hmacHex, safeEqual } from '../common/crypto';

export interface PaystackAuthorization {
  authorization_code?: string;
  signature?: string;
  reusable?: boolean;
  channel?: string;
  brand?: string;
  card_type?: string;
  last4?: string;
  exp_month?: string;
  exp_year?: string;
  bank?: string;
}

/** The `data` of a Paystack transaction (verify, charge, charge.* events). */
export interface PaystackTransaction {
  id?: number;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  channel?: string;
  gateway_response?: string;
  paid_at?: string | null;
  fees?: number | null;
  authorization?: PaystackAuthorization;
  metadata?: unknown;
}

interface Envelope<T> {
  status: boolean;
  message?: string;
  data: T;
}

/** Thin Paystack REST client. All calls use the one Alcance secret key. */
@Injectable()
export class PaystackClient {
  private readonly logger = new Logger(PaystackClient.name);

  constructor(@Inject(PAY_CONFIG) private readonly config: PayConfig) {}

  /** True when a webhook body was signed by Paystack with our secret key. */
  verifySignature(
    rawBody: Buffer | string,
    signature: string | undefined,
  ): boolean {
    if (!signature) return false;
    return safeEqual(
      hmacHex('sha512', this.config.paystackSecretKey, rawBody),
      signature,
    );
  }

  initialize(body: {
    email: string;
    amount: number;
    reference: string;
    currency: string;
    callback_url?: string;
    channels?: string[];
    metadata?: Record<string, unknown>;
    subaccount?: string;
  }) {
    return this.request<{
      authorization_url: string;
      access_code: string;
      reference: string;
    }>('POST', '/transaction/initialize', body);
  }

  verify(reference: string) {
    return this.request<PaystackTransaction>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
  }

  chargeAuthorization(body: {
    authorization_code: string;
    email: string;
    amount: number;
    reference: string;
    currency: string;
    metadata?: Record<string, unknown>;
    subaccount?: string;
  }) {
    return this.request<PaystackTransaction>(
      'POST',
      '/transaction/charge_authorization',
      body,
    );
  }

  deactivateAuthorization(authorizationCode: string) {
    return this.request<unknown>('POST', '/customer/deactivate_authorization', {
      authorization_code: authorizationCode,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.paystackBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.paystackSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      this.logger.error(`Paystack ${method} ${path} unreachable`, err as Error);
      throw new BadGatewayException('Payment provider unreachable');
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.status) {
      this.logger.warn(
        `Paystack ${method} ${path} → ${res.status}: ${json?.message ?? 'no body'}`,
      );
      throw new BadGatewayException(
        json?.message || `Payment provider error (${res.status})`,
      );
    }
    return json.data;
  }
}
