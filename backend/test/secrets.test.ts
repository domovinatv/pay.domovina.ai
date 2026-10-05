import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, importKek, SecretsError } from '../src/tenants/secrets';

function kekB64(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
}

describe('tenant secrets (AES-GCM, AAD = tenant|field)', () => {
  it('round-trips a secret for the tenant and field it was written for', async () => {
    const kek = await importKek(kekB64(7));
    const blob = await encryptSecret(kek, 'zupa-a', 'client_secret', 's3cr3t');
    expect(blob).toMatch(/^v1:[^:]+:[^:]+$/);
    expect(await decryptSecret(kek, 'zupa-a', 'client_secret', blob)).toBe('s3cr3t');
  });

  it('never produces the same ciphertext twice (random IV)', async () => {
    const kek = await importKek(kekB64(7));
    const a = await encryptSecret(kek, 'zupa-a', 'client_secret', 'x');
    const b = await encryptSecret(kek, 'zupa-a', 'client_secret', 'x');
    expect(a).not.toBe(b);
  });

  it("refuses another tenant's ciphertext transplanted into this tenant's row", async () => {
    const kek = await importKek(kekB64(7));
    const ofB = await encryptSecret(kek, 'zupa-b', 'router_key', '0xkey-of-b');
    await expect(decryptSecret(kek, 'zupa-a', 'router_key', ofB)).rejects.toBeInstanceOf(SecretsError);
  });

  it('refuses a ciphertext moved to a different field of the same tenant', async () => {
    const kek = await importKek(kekB64(7));
    const blob = await encryptSecret(kek, 'zupa-a', 'webhook_secret', 'whsec_x');
    await expect(decryptSecret(kek, 'zupa-a', 'router_key', blob)).rejects.toBeInstanceOf(SecretsError);
  });

  it('refuses decryption under a different KEK', async () => {
    const blob = await encryptSecret(await importKek(kekB64(7)), 'zupa-a', 'client_secret', 'x');
    await expect(
      decryptSecret(await importKek(kekB64(9)), 'zupa-a', 'client_secret', blob),
    ).rejects.toBeInstanceOf(SecretsError);
  });

  it('rejects a missing, non-base64 or wrong-length KEK', async () => {
    await expect(importKek(undefined)).rejects.toBeInstanceOf(SecretsError);
    await expect(importKek('   ')).rejects.toBeInstanceOf(SecretsError);
    await expect(importKek('%%%')).rejects.toBeInstanceOf(SecretsError);
    await expect(importKek(btoa('short'))).rejects.toBeInstanceOf(SecretsError);
  });

  it('rejects an unknown format version', async () => {
    const kek = await importKek(kekB64(7));
    await expect(decryptSecret(kek, 'zupa-a', 'client_secret', 'v0:a:b')).rejects.toBeInstanceOf(SecretsError);
  });
});
