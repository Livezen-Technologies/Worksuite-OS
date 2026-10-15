// RFC 7636 PKCE (S256) and an unguessable state value (WSOS-IDN-001).
import { createHash, randomBytes } from 'node:crypto';

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const randomState = () => randomBytes(16).toString('base64url');
