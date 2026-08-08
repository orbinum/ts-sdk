/**
 * The in-memory backend against the shared contract. The same suite runs on
 * every other implementation — that is what makes the contract a contract.
 */
import { MemoryVaultStorage } from '../../../../src/wallet/vault/storage/MemoryVaultStorage';
import { testVaultStorageConformance } from './storageConformance';

testVaultStorageConformance('MemoryVaultStorage', () => new MemoryVaultStorage());
