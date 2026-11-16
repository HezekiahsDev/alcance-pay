import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { App, Delivery, WebhookEvent } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { hmacHex } from '../common/crypto';

/** Wait before each retry; after the last one the delivery is marked FAILED. */
export const RETRY_DELAYS_MS = [
  60_000, // 1 min
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
];

/**
 * Forwards events to apps:
 *  - PAYSTACK mode: Paystack's exact body with its original
 *    x-paystack-signature, so an app's existing Paystack webhook works as-is.
 *  - ALCANCE mode: a normalized event signed with the app's webhook secret:
 *    X-Alcance-Signature = hex HMAC-SHA256(secret, `${timestamp}.${body}`).
 */
@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  /** Creates the delivery and tries it straight away (retries run on a timer). */
  async schedule(event: WebhookEvent, app: App) {
    const delivery = await this.prisma.delivery.upsert({
      where: { eventId_appId: { eventId: event.id, appId: app.id } },
      create: { eventId: event.id, appId: app.id },
      update: {},
    });
    void this.attempt(delivery.id).catch((err) =>
      this.logger.error(`Delivery ${delivery.id} attempt failed`, err as Error),
    );
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'webhook-retries' })
  async retryDue() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.delivery.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: 50,
        select: { id: true },
      });
      for (const d of due) await this.attempt(d.id);
    } finally {
      this.running = false;
    }
  }

  async attempt(deliveryId: string): Promise<Delivery> {
    const delivery = await this.prisma.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { event: true, app: true },
    });
    if (delivery.status !== 'PENDING' || !delivery.app.webhookUrl)
      return delivery;

    const { body, headers } = await this.request(
      delivery.event,
      delivery.app,
      delivery.id,
    );
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(delivery.app.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message;
    }

    const attempts = delivery.attempts + 1;
    if (!error) {
      return this.prisma.delivery.update({
        where: { id: delivery.id },
        data: {
          status: 'DELIVERED',
          attempts,
          lastStatus: status,
          lastError: null,
          deliveredAt: new Date(),
        },
      });
    }
    const delay = RETRY_DELAYS_MS[attempts - 1];
    this.logger.warn(
      `Delivery of ${delivery.event.event} to ${delivery.appId} failed (${error}); ${delay ? 'will retry' : 'giving up'}`,
    );
    return this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        attempts,
        lastStatus: status,
        lastError: error.slice(0, 500),
        status: delay ? 'PENDING' : 'FAILED',
        nextAttemptAt: new Date(Date.now() + (delay ?? 0)),
      },
    });
  }

  private async request(
    event: WebhookEvent,
    app: App,
    deliveryId: string,
  ): Promise<{ body: string; headers: Record<string, string> }> {
    if (app.forwardMode === 'PAYSTACK') {
      return {
        body: event.rawBody,
        headers: { 'x-paystack-signature': event.signature },
      };
    }
    const payment = event.reference
      ? await this.prisma.payment.findUnique({
          where: { reference: event.reference },
        })
      : null;
    const body = JSON.stringify({
      id: event.id,
      type: event.event,
      app: app.id,
      createdAt: event.receivedAt,
      // Normalized payment for payments started here; Paystack's data otherwise.
      payment:
        payment && payment.appId === app.id
          ? await this.payments.view(payment)
          : null,
      data: (event.payload as { data?: unknown }).data ?? null,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      body,
      headers: {
        'X-Alcance-Event': event.event,
        'X-Alcance-Delivery': deliveryId,
        'X-Alcance-Timestamp': timestamp,
        'X-Alcance-Signature': hmacHex(
          'sha256',
          app.webhookSecret,
          `${timestamp}.${body}`,
        ),
      },
    };
  }
}
