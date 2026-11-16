import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { App, Card, Payment, PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import {
  PaystackClient,
  PaystackTransaction,
} from '../paystack/paystack.client';
import { Cipher } from '../common/crypto';
import { CARD_CIPHER } from './cipher.provider';
import { ChargeCardDto, CreateCheckoutDto } from './payments.dto';

/** What apps get back for a payment (and in forwarded events). */
export interface PaymentView {
  reference: string;
  status: PaymentStatus;
  kind: string;
  amount: number;
  currency: string;
  email: string;
  customerId: string | null;
  channel: string | null;
  gatewayResponse: string | null;
  paidAt: Date | null;
  metadata: unknown;
  card: CardView | null;
}

export interface CardView {
  id: string;
  customerId: string;
  brand: string | null;
  last4: string | null;
  expMonth: string | null;
  expYear: string | null;
  bank: string | null;
}

export const cardView = (c: Card): CardView => ({
  id: c.id,
  customerId: c.customerId,
  brand: c.brand,
  last4: c.last4,
  expMonth: c.expMonth,
  expYear: c.expYear,
  bank: c.bank,
});

const STATUS: Record<string, PaymentStatus> = {
  success: 'SUCCESS',
  failed: 'FAILED',
  reversed: 'FAILED',
  abandoned: 'ABANDONED',
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackClient,
    @Inject(CARD_CIPHER) private readonly cipher: Cipher,
  ) {}

  // ─── Checkout ─────────────────────────────────────────────────────────────

  async createCheckout(app: App, dto: CreateCheckoutDto) {
    if (dto.saveCard && !dto.customerId) {
      throw new BadRequestException('customerId is required to save a card');
    }
    if (dto.callbackUrl) this.assertCallbackAllowed(app, dto.callbackUrl);
    const reference = dto.reference ?? this.newReference(app);
    const currency = dto.currency ?? 'NGN';

    try {
      await this.prisma.payment.create({
        data: {
          appId: app.id,
          reference,
          kind: 'CHECKOUT',
          email: dto.email.toLowerCase(),
          customerId: dto.customerId ?? null,
          amount: dto.amount,
          currency,
          saveCard: !!dto.saveCard,
          metadata: (dto.metadata ?? undefined) as
            Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          'A payment with this reference already exists',
        );
      }
      throw err;
    }

    try {
      const init = await this.paystack.initialize({
        email: dto.email,
        amount: dto.amount,
        currency,
        reference,
        callback_url: dto.callbackUrl,
        // saveCard doesn't restrict payment methods: the card is saved only
        // if the customer chooses to pay by card.
        channels: dto.channels,
        subaccount: app.subaccountCode ?? undefined,
        metadata: {
          app: app.id,
          customerId: dto.customerId ?? null,
          ...(dto.metadata ?? {}),
        },
      });
      return {
        reference,
        authorizationUrl: init.authorization_url,
        accessCode: init.access_code,
      };
    } catch (err) {
      // Nothing was charged; drop the record so the reference can be retried.
      await this.prisma.payment
        .delete({ where: { reference } })
        .catch(() => undefined);
      throw err;
    }
  }

  /** Asks Paystack for the latest status and records it. Idempotent. */
  async verify(app: App, reference: string): Promise<PaymentView> {
    const payment =
      (await this.adoptLegacy(app, reference)) ??
      (await this.ownPayment(app, reference));
    if (payment.status === 'SUCCESS') return this.view(payment);
    const data = await this.paystack.verify(reference);
    return this.view(await this.applyResult(payment, data));
  }

  async get(app: App, reference: string): Promise<PaymentView> {
    return this.view(await this.ownPayment(app, reference));
  }

  // ─── Saved cards ──────────────────────────────────────────────────────────

  /**
   * Charges a saved card. The result is usually final (SUCCESS / FAILED); if
   * Paystack reports it pending, the final status arrives as an event.
   */
  async chargeCard(app: App, dto: ChargeCardDto): Promise<PaymentView> {
    const card = await this.prisma.card.findFirst({
      where: { id: dto.cardId, appId: app.id, active: true },
    });
    if (!card) throw new NotFoundException('Card not found');
    const reference = dto.reference ?? this.newReference(app);

    let payment: Payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          appId: app.id,
          reference,
          kind: 'CARD_CHARGE',
          email: card.email,
          customerId: card.customerId,
          amount: dto.amount,
          currency: 'NGN',
          cardId: card.id,
          metadata: (dto.metadata ?? undefined) as
            Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // Same reference again: report the existing charge, never charge twice.
        return this.verify(app, reference);
      }
      throw err;
    }

    let data: PaystackTransaction;
    try {
      data = await this.paystack.chargeAuthorization({
        authorization_code: this.cipher.decrypt(card.authorizationEncrypted),
        email: card.email,
        amount: dto.amount,
        currency: 'NGN',
        reference,
        subaccount: app.subaccountCode ?? undefined,
        metadata: {
          app: app.id,
          customerId: card.customerId,
          ...(dto.metadata ?? {}),
        },
      });
    } catch (err) {
      // Paystack refused the request outright (e.g. invalid authorization).
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', gatewayResponse: (err as Error).message },
      });
      throw err;
    }
    return this.view(await this.applyResult(payment, data));
  }

  async listCards(app: App, customerId: string): Promise<CardView[]> {
    const cards = await this.prisma.card.findMany({
      where: { appId: app.id, customerId, active: true },
      orderBy: { createdAt: 'desc' },
    });
    return cards.map(cardView);
  }

  async removeCard(app: App, cardId: string) {
    const card = await this.prisma.card.findFirst({
      where: { id: cardId, appId: app.id },
    });
    if (!card) throw new NotFoundException('Card not found');
    if (card.active) {
      await this.paystack
        .deactivateAuthorization(
          this.cipher.decrypt(card.authorizationEncrypted),
        )
        .catch((err) =>
          this.logger.warn(
            `Paystack deactivate failed for card ${card.id}: ${err}`,
          ),
        );
      await this.prisma.card.update({
        where: { id: card.id },
        data: { active: false },
      });
    }
    return { removed: true };
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  /**
   * Records a Paystack transaction result on a payment. Only moves a payment
   * out of PENDING/FAILED/ABANDONED once into SUCCESS (never back), checks the
   * amount and currency, and saves a reusable card when asked.
   */
  async applyResult(
    payment: Payment,
    data: PaystackTransaction,
  ): Promise<Payment> {
    let status = STATUS[data.status ?? ''] ?? 'PENDING';
    let gatewayResponse = data.gateway_response ?? null;
    if (
      status === 'SUCCESS' &&
      ((data.amount ?? 0) < payment.amount ||
        (data.currency && data.currency !== payment.currency))
    ) {
      this.logger.error(`Amount/currency mismatch on ${payment.reference}`);
      status = 'FAILED';
      gatewayResponse = 'amount_mismatch';
    }
    if (payment.status === 'SUCCESS' || status === payment.status)
      return payment;

    const updated = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: { not: 'SUCCESS' } },
      data: {
        status,
        gatewayResponse,
        channel: data.channel ?? null,
        paystackId: data.id ? String(data.id) : null,
        fees: data.fees ?? null,
        paidAt:
          status === 'SUCCESS'
            ? data.paid_at
              ? new Date(data.paid_at)
              : new Date()
            : null,
      },
    });
    let fresh = await this.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    if (
      updated.count &&
      status === 'SUCCESS' &&
      payment.saveCard &&
      !payment.cardId
    ) {
      const card = await this.saveCard(fresh, data);
      if (card) {
        fresh = await this.prisma.payment.update({
          where: { id: payment.id },
          data: { cardId: card.id },
        });
      }
    }
    return fresh;
  }

  private async saveCard(
    payment: Payment,
    data: PaystackTransaction,
  ): Promise<Card | null> {
    const auth = data.authorization;
    if (!payment.customerId || !auth?.reusable || !auth.authorization_code)
      return null;
    const signature = auth.signature || auth.authorization_code;
    const fields = {
      email: payment.email,
      authorizationEncrypted: this.cipher.encrypt(auth.authorization_code),
      brand: auth.brand ?? auth.card_type ?? null,
      last4: auth.last4 ?? null,
      expMonth: auth.exp_month ?? null,
      expYear: auth.exp_year ?? null,
      bank: auth.bank ?? null,
      active: true,
    };
    return this.prisma.card.upsert({
      where: {
        appId_customerId_signature: {
          appId: payment.appId,
          customerId: payment.customerId,
          signature,
        },
      },
      create: {
        appId: payment.appId,
        customerId: payment.customerId,
        signature,
        ...fields,
      },
      update: fields,
    });
  }

  async view(payment: Payment): Promise<PaymentView> {
    const card = payment.cardId
      ? await this.prisma.card.findUnique({ where: { id: payment.cardId } })
      : null;
    return {
      reference: payment.reference,
      status: payment.status,
      kind: payment.kind,
      amount: payment.amount,
      currency: payment.currency,
      email: payment.email,
      customerId: payment.customerId,
      channel: payment.channel,
      gatewayResponse: payment.gatewayResponse,
      paidAt: payment.paidAt,
      metadata: payment.metadata,
      card: card ? cardView(card) : null,
    };
  }

  /**
   * A payment the app started directly with Paystack before moving to this
   * service (its reference has one of the app's prefixes): record it here so
   * verify works for it too. Returns null when there's nothing to adopt.
   */
  private async adoptLegacy(
    app: App,
    reference: string,
  ): Promise<Payment | null> {
    if (await this.prisma.payment.findUnique({ where: { reference } }))
      return null;
    if (!app.referencePrefixes.some((p) => p && reference.startsWith(p)))
      return null;
    const data = await this.paystack.verify(reference).catch(() => null);
    if (!data?.reference || data.amount === undefined) return null;
    const customer = (data as { customer?: { email?: string } }).customer;
    const payment = await this.prisma.payment.create({
      data: {
        appId: app.id,
        reference,
        kind: 'CHECKOUT',
        email: (customer?.email ?? 'unknown@legacy').toLowerCase(),
        amount: data.amount,
        currency: data.currency ?? 'NGN',
        metadata: { adopted: true } as Prisma.InputJsonValue,
      },
    });
    return payment;
  }

  private async ownPayment(app: App, reference: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { reference },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.appId !== app.id)
      throw new ForbiddenException('Payment not found');
    return payment;
  }

  private newReference(app: App) {
    return `${app.id.toUpperCase()}-${randomUUID()}`;
  }

  private assertCallbackAllowed(app: App, callbackUrl: string) {
    const origin = new URL(callbackUrl).origin;
    if (!app.callbackOrigins.includes(origin)) {
      throw new BadRequestException(
        `callbackUrl origin ${origin} is not registered for this app`,
      );
    }
  }
}
