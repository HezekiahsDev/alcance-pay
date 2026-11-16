import { Provider } from '@nestjs/common';
import { Cipher } from '../common/crypto';
import { PAY_CONFIG, PayConfig } from '../config';

export const CARD_CIPHER = Symbol('CARD_CIPHER');

export const cipherProvider: Provider = {
  provide: CARD_CIPHER,
  inject: [PAY_CONFIG],
  useFactory: (config: PayConfig) => new Cipher(config.cardEncryptionKey),
};
