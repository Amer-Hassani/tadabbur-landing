import { defineConfig } from 'astro/config';

// Cloudflare Pages sets CF_PAGES_BRANCH on every build. Any branch other than
// `main` is treated as staging and gets the staging API base — so we don't have
// to configure a separate build command per branch in the dashboard.
const branch = process.env.CF_PAGES_BRANCH || '';
const isStaging = branch !== '' && branch !== 'main';

const PROD_API = 'https://tadabbur-tafsir-api.amer19hs.workers.dev';
const STAGING_API = 'https://tadabbur-tafsir-api-staging.amer19hs.workers.dev';

export default defineConfig({
  site: 'https://tadabbur.tarteeb.pro',
  vite: {
    define: {
      // Overrides import.meta.env.PUBLIC_API_BASE at build time based on branch.
      'import.meta.env.PUBLIC_API_BASE': JSON.stringify(isStaging ? STAGING_API : PROD_API),
    },
  },
});
