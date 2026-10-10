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

describe('KEK rotation (MT-06)', () => {
  it('reads a blob written under the previous KEK while PREV is set; not after', async () => {
    const { importKeks } = await import('../src/tenants/secrets');
    const old = await importKek(kekB64(1));
    const blob = await encryptSecret(old, 'zupa-a', 'router_key', '0xsecret');
    const during = await importKeks({ TENANT_SECRETS_KEK: kekB64(2), TENANT_SECRETS_KEK_PREV: kekB64(1) });
    expect(await decryptSecret(during, 'zupa-a', 'router_key', blob)).toBe('0xsecret');
    const after = await importKeks({ TENANT_SECRETS_KEK: kekB64(2) });
    await expect(decryptSecret(after, 'zupa-a', 'router_key', blob)).rejects.toBeInstanceOf(SecretsError);
  });

  it('a malformed PREV is an error, not silently ignored', async () => {
    const { importKeks } = await import('../src/tenants/secrets');
    await expect(importKeks({ TENANT_SECRETS_KEK: kekB64(2), TENANT_SECRETS_KEK_PREV: 'nope' })).rejects.toBeInstanceOf(SecretsError);
  });

  it('rewrap re-encrypts every stored secret under the current KEK (real SQLite)', async () => {
    const { migratedD1 } = await import('./helpers/sqliteD1');
    const { rewrapTenantSecrets } = await import('../src/tenants/onboarding');
    const { db, raw } = migratedD1();
    const old = await importKek(kekB64(1));
    raw.prepare(`INSERT INTO tenants (id, name, status, allow_sources, beneficiary_name, iban, created_at, updated_at)
                 VALUES ('zupa-a', 'Župa A', 'active', '[]', 'Župa A', 'HR0000000000000000000', 0, 0)`).run();
    raw.prepare(`INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id, receiving_safe, router_key_enc, created_at, updated_at)
                 VALUES ('zupa-a', 'sandbox', 'chiado', 'cid', ?, 'pid', '0x0', ?, 0, 0)`)
      .run(await encryptSecret(old, 'zupa-a', 'client_secret', 'cs'), await encryptSecret(old, 'zupa-a', 'router_key', 'rk'));
    const env = { DB: db, TENANT_SECRETS_KEK: kekB64(2), TENANT_SECRETS_KEK_PREV: kekB64(1) } as never;
    expect(await rewrapTenantSecrets(env, 'zupa-a')).toBe(2);
    const row = raw.prepare(`SELECT client_secret_enc, router_key_enc FROM tenant_rail`).get() as Record<string, string>;
    const fresh = await importKek(kekB64(2));
    expect(await decryptSecret(fresh, 'zupa-a', 'client_secret', row.client_secret_enc)).toBe('cs');
    expect(await decryptSecret(fresh, 'zupa-a', 'router_key', row.router_key_enc)).toBe('rk');
  });
});
