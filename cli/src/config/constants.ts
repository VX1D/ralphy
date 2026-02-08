// Lock Management
export const LOCK_TIMEOUT_MS = 30000; // 30 seconds
export const LOCK_MAX_LOCKS = 5000; // Maximum number of locks
export const LOCK_DIR = ".ralphy/locks"; // Lock directory
export const LOCK_CLEANUP_INTERVAL_MS = 60000; // 1 minute between cleanups

// Hash Store Constants
export const HASH_STORE_DIR = ".ralphy-hashes";
export const HASH_STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_FILE_SIZE_FOR_HASH = 2 * 1024 * 1024; // 2MB
export const ENABLE_HASH_STORE = true; // Feature flag
