import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { App } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PaystackClient } from '../paystack/paystack.client';
import { matchPrefix } from '../apps/apps.service';

export type TransferState =
  'success' | 'pending' | 'failed' | 'reversed' | 'not_found';

/** Bank lookups and payouts (Paystack transfers) for apps. */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackClient,
  ) {}

  async banks() {
    const banks = await this.paystack.listBanks('NGN');
    return banks.map((b) => ({ name: b.name, code: b.code }));
  }

  async resolve(accountNumber: string, bankCode: string) {
    const r = await this.paystack.resolveAccount(accountNumber, bankCode);
    return { accountNumber: r.account_number, accountName: r.account_name };
  }

  async createRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
  }) {
    const r = await this.paystack.createTransferRecipient({
      name: input.name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
    });
    return { recipientCode: r.recipient_code };
  }

  /**
   * Starts a transfer. The reference is the app's idempotency key: repeating
   * it never starts a second transfer.
   */
  async transfer(
    app: App,
    input: {
      amount: number;
      recipientCode: string;
      reference: string;
      reason?: string;
    },
  ) {
    const existing = await this.prisma.transfer.findUnique({
      where: { reference: input.reference },
    });
    if (existing) {
      if (existing.appId !== app.id)
        throw new ConflictException('Reference already used');
      return {
        status: existing.status,
        transferCode: existing.transferCode,
        reference: existing.reference,
      };
    }
    await this.prisma.transfer.create({
      data: {
        appId: app.id,
        reference: input.reference,
        amount: input.amount,
        recipientCode: input.recipientCode,
        reason: input.reason,
      },
    });
    // If this throws, the app should call status(): a request that failed or
    // timed out may still have been accepted by Paystack.
    const r = await this.paystack.initiateTransfer({
      amount: input.amount,
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason,
    });
    await this.prisma.transfer.update({
      where: { reference: input.reference },
      data: { status: r.status, transferCode: r.transfer_code },
    });
    return {
      status: r.status,
      transferCode: r.transfer_code,
      reference: input.reference,
    };
  }

  /**
   * What actually happened to a transfer, from Paystack. `not_found` means
   * Paystack never accepted it (safe to refund the user).
   */
  async status(
    app: App,
    reference: string,
  ): Promise<{ status: TransferState }> {
    await this.assertOwns(app, reference);
    const t = await this.paystack.verifyTransfer(reference);
    if (!t) return { status: 'not_found' };
    const status: TransferState =
      t.status === 'success' || t.status === 'failed' || t.status === 'reversed'
        ? t.status
        : 'pending';
    await this.prisma.transfer
      .updateMany({ where: { reference }, data: { status: t.status } })
      .catch(() => undefined);
    return { status };
  }

  /** Transfers started here, or (legacy) references under the app's prefixes. */
  private async assertOwns(app: App, reference: string) {
    const t = await this.prisma.transfer.findUnique({ where: { reference } });
    if (t) {
      if (t.appId !== app.id)
        throw new ForbiddenException('Transfer not found');
      return;
    }
    if (!matchPrefix([app], reference)) {
      throw new ForbiddenException('Transfer not found');
    }
  }
}
