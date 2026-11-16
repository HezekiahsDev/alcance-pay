import {
  BadGatewayException,
  BadRequestException,
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

  // ─── Banks and transfers (payouts) ───────────────────────────────────────

  listBanks(currency = 'NGN') {
    return this.request<Array<{ name: string; code: string }>>(
      'GET',
      `/bank?currency=${encodeURIComponent(currency)}&perPage=100`,
    );
  }

  resolveAccount(accountNumber: string, bankCode: string) {
    return this.request<{ account_number: string; account_name: string }>(
      'GET',
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
  }

  createTransferRecipient(body: {
    name: string;
    account_number: string;
    bank_code: string;
  }) {
    return this.request<{ recipient_code: string }>(
      'POST',
      '/transferrecipient',
      { type: 'nuban', currency: 'NGN', ...body },
    );
  }

  initiateTransfer(body: {
    amount: number;
    recipient: string;
    reference: string;
    reason?: string;
  }) {
    return this.request<{ status: string; transfer_code: string }>(
      'POST',
      '/transfer',
      { source: 'balance', ...body },
    );
  }

  /** Transfer by reference; null when Paystack has no such transfer. */
  verifyTransfer(reference: string) {
    return this.request<{ status: string; transfer_code?: string }>(
      'GET',
      `/transfer/verify/${encodeURIComponent(reference)}`,
      undefined,
      { notFoundAsNull: true },
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts: { notFoundAsNull?: boolean } = {},
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
    if (res.status === 404 && opts.notFoundAsNull) return null as T;
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.status) {
      this.logger.warn(
        `Paystack ${method} ${path} → ${res.status}: ${json?.message ?? 'no body'}`,
      );
      const message = json?.message || `Payment provider error (${res.status})`;
      // Paystack rejected the input (e.g. an account that doesn't resolve):
      // pass its message on as a client error. Auth/rate/server problems on
      // Paystack's side are a 502.
      if ([400, 404, 422].includes(res.status)) {
        throw new BadRequestException(message);
      }
      throw new BadGatewayException(message);
    }
    return json.data;
  }
}
