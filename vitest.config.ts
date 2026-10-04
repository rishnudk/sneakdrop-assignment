import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false, // Prevent DB state collisions during integration tests
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
