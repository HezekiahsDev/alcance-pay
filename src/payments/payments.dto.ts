import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const REFERENCE = /^[A-Za-z0-9._=-]{6,100}$/;

export class CreateCheckoutDto {
  @IsEmail()
  email: string;

  /** Amount in kobo (₦1 = 100). */
  @IsInt()
  @Min(100)
  amount: number;

  @IsOptional()
  @IsIn(['NGN'])
  currency?: string;

  /** Your own unique reference; generated if omitted. */
  @IsOptional()
  @Matches(REFERENCE, { message: 'reference: 6–100 letters, digits, . _ = -' })
  reference?: string;

  /** Where Paystack returns the customer (must be one of the app's origins). */
  @IsOptional()
  @IsUrl({
    protocols: ['https', 'http'],
    require_protocol: true,
    require_tld: false,
  })
  callbackUrl?: string;

  /** Your id for the customer; required to save the card. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customerId?: string;

  /** Save the card for later charges (card payments only). */
  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;

  /** Restrict payment methods, e.g. ["card"]. */
  @IsOptional()
  @IsIn(
    ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer', 'eft'],
    { each: true },
  )
  channels?: string[];

  /** Returned with every event for this payment. */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ChargeCardDto {
  @IsUUID()
  cardId: string;

  /** Amount in kobo. */
  @IsInt()
  @Min(100)
  amount: number;

  @IsOptional()
  @Matches(REFERENCE, { message: 'reference: 6–100 letters, digits, . _ = -' })
  reference?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
