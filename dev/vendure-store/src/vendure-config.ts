import {
  DefaultJobQueuePlugin,
  DefaultSchedulerPlugin,
  DefaultSearchPlugin,
  LanguageCode,
  OrderLevelTaxCalculationStrategy,
  VendureConfig,
  dummyPaymentHandler,
} from '@vendure/core';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import { TallyPosPlugin } from '@vendurepos/plugin';
import path from 'path';
import {
  COOKIE_SECRET,
  CORS_ORIGINS,
  DB_HOST,
  DB_NAME,
  DB_PASSWORD,
  DB_PORT,
  DB_USERNAME,
  DEFAULT_CHANNEL_TOKEN,
  SERVER_HOST,
  SERVER_PORT,
  SUPERADMIN_PASSWORD,
  SUPERADMIN_USERNAME,
} from './constants';

export const config: VendureConfig = {
  apiOptions: {
    hostname: SERVER_HOST,
    port: SERVER_PORT,
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
    cors: { origin: CORS_ORIGINS, credentials: true },
    adminApiDebug: true,
    shopApiDebug: true,
  },
  authOptions: {
    tokenMethod: ['bearer', 'cookie', 'api-key'],
    superadminCredentials: {
      identifier: SUPERADMIN_USERNAME,
      password: SUPERADMIN_PASSWORD,
    },
    cookieOptions: { secret: COOKIE_SECRET },
  },
  defaultChannelToken: DEFAULT_CHANNEL_TOKEN,
  dbConnectionOptions: {
    type: 'postgres',
    host: DB_HOST,
    port: DB_PORT,
    username: DB_USERNAME,
    password: DB_PASSWORD,
    database: DB_NAME,
    synchronize: false,
    logging: false,
  },
  paymentOptions: { paymentMethodHandlers: [dummyPaymentHandler] },
  taxOptions: {
    // The e2e seed is tax-exclusive; the plan's tax-parity acceptance needs this strategy.
    orderTaxCalculationStrategy: new OrderLevelTaxCalculationStrategy(),
  },
  customFields: {
    ProductVariant: [{
      name: 'barcode',
      type: 'string',
      nullable: true,
      label: [{ languageCode: LanguageCode.en, value: 'Barcode' }],
    }],
  },
  plugins: [
    DefaultSchedulerPlugin.init(),
    DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
    DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
    // POST /tally/v1/commands. Its tables and columns come from the seed's synchronize (no migrations
    // here); on start it gives every channel the POS payment and shipping methods and the walk-in customer.
    TallyPosPlugin,
    // npm run dashboard:build builds it; without the build, /dashboard shows Vendure's default page and nothing else changes.
    DashboardPlugin.init({ route: 'dashboard', appDir: path.join(__dirname, '../dist/dashboard') }),
  ],
};
