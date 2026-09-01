import { createApiClient } from '@roofing-crm/api-client';

/**
 * The app never constructs a tRPC client itself — transport configuration lives in
 * `@roofing-crm/api-client` so every future frontend shares one typed client.
 */
export const api = createApiClient({ url: import.meta.env.VITE_API_URL });
