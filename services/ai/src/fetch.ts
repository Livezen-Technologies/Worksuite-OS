// The only network use in worksuite-ai: model downloads.

/**
 * fetch for model downloads: https only, and a redirect is followed only to a host the catalog allows. Nothing else
 * in this service reaches the network.
 */
export function restrictedFetch(hosts: () => string[], base: typeof fetch = fetch) {
  return async (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> => {
    let at = url;
    for (let hop = 0; hop < 6; hop++) {
      const u = new URL(at);
      if (u.protocol !== 'https:' || !hosts().includes(u.hostname)) throw new Error('host_not_allowed');
      const res = await base(at, { ...init, redirect: 'manual', cache: 'no-store' });
      if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) return res;
      at = new URL(res.headers.get('location')!, at).toString();
    }
    throw new Error('download_failed');
  };
}

