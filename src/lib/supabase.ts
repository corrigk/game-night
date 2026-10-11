import { createClient, type Session } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && key && !url.includes('your-project-ref'));

/**
 * `?as=2` gives this tab its own identity, so you can simulate several phones in
 * one browser while testing. Real phones never need it.
 */
export const slot = new URLSearchParams(window.location.search).get('as') ?? '';
export const storageSuffix = slot ? `:${slot}` : '';

export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: `partypack-auth${storageSuffix}` },
  realtime: { params: { eventsPerSecond: 20 } },
});

let sessionPromise: Promise<Session> | null = null;

/** Reuse the persisted anonymous session, or create one. */
export function ensureSession(): Promise<Session> {
  sessionPromise ??= (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) return data.session;
    const { data: signed, error } = await supabase.auth.signInAnonymously();
    if (error || !signed.session) {
      sessionPromise = null;
      throw error ?? new Error('Anonymous sign-in failed');
    }
    return signed.session;
  })();
  return sessionPromise;
}

/** Postgres `raise exception 'CODE'` arrives as error.message === 'CODE'. */
export function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
