/**
 * The plain in-memory session against the shared contract. The app's
 * Zustand-backed adapter runs the same suite.
 */
import { createWalletSession } from '../../../../src/wallet/vault/session/WalletSession';
import { testWalletSessionConformance } from './sessionConformance';

testWalletSessionConformance('createWalletSession', () => createWalletSession());
