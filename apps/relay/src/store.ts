import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { generateDeviceToken, verifyDeviceSecret } from "./device-token.js";
import { relayPoolOptions } from "./database-options.js";

export interface DeviceRecord {
  id: string;
  accountId: string;
  name: string;
  platform: string | null;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
}

export interface RelayStore {
  accountIdForSubject(subject: string): Promise<string | null>;
  enrollDevice(
    accountId: string,
    name: string,
    platform: string | null,
  ): Promise<{ device: DeviceRecord; token: string }>;
  listDevices(accountId: string): Promise<DeviceRecord[]>;
  renameDevice(
    accountId: string,
    deviceId: string,
    name: string,
  ): Promise<DeviceRecord | null>;
  revokeDevice(accountId: string, deviceId: string): Promise<boolean>;
  touchDevice(accountId: string, deviceId: string): Promise<boolean>;
  authenticateDevice(
    deviceId: string,
    secret: string,
  ): Promise<DeviceRecord | null>;
}

const DUMMY_TOKEN_SALT = Buffer.alloc(16);
const DUMMY_TOKEN_HASH = Buffer.alloc(32);

export class Store implements RelayStore {
  readonly #pool: Pool;

  constructor(databaseUrl: string, pool?: Pool) {
    this.#pool =
      pool ??
      new Pool(relayPoolOptions(databaseUrl));
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async accountIdForSubject(subject: string): Promise<string | null> {
    const existing = await this.#pool.query<{
      id: string;
      admitted_at: Date | null;
      disabled_at: Date | null;
    }>(
      `SELECT id, admitted_at, disabled_at
       FROM accounts
       WHERE auth0_subject = $1
       FOR NO KEY UPDATE`,
      [subject],
    );
    const account = existing.rows[0];
    if (account?.disabled_at) return null;
    if (account?.admitted_at) return account.id;

    const admitted = await this.#pool.query<{ id: string }>(
      `INSERT INTO accounts (id, auth0_subject, admitted_at)
       VALUES ($1, $2, now())
       ON CONFLICT (auth0_subject) DO UPDATE
       SET admitted_at = COALESCE(accounts.admitted_at, EXCLUDED.admitted_at)
       WHERE accounts.disabled_at IS NULL
       RETURNING accounts.id`,
      [randomUUID(), subject],
    );
    return admitted.rows[0]?.id ?? null;
  }

  async enrollDevice(
    accountId: string,
    name: string,
    platform: string | null,
  ): Promise<{ device: DeviceRecord; token: string }> {
    const generated = await generateDeviceToken();
    return await this.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        account_id: string;
        name: string;
        platform: string | null;
        revoked_at: Date | null;
        last_seen_at: Date | null;
      }>(
        `INSERT INTO devices (
           id, account_id, name, platform, token_salt, token_hash, token_version
         ) VALUES ($1, $2, $3, $4, $5, $6, 1)
         RETURNING id, account_id, name, platform, revoked_at, last_seen_at`,
        [
          generated.deviceId,
          accountId,
          name,
          platform,
          generated.salt,
          generated.hash,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Failed to enroll device.");
      await client.query(
        `INSERT INTO audit_events (
           id, account_id, device_id, event_type, outcome
         ) VALUES ($1, $2, $3, 'device_enrolled', 'success')`,
        [randomUUID(), accountId, generated.deviceId],
      );
      return {
        device: {
          id: row.id,
          accountId: row.account_id,
          name: row.name,
          platform: row.platform,
          revokedAt: row.revoked_at,
          lastSeenAt: row.last_seen_at,
        },
        token: generated.token,
      };
    });
  }

  async listDevices(accountId: string): Promise<DeviceRecord[]> {
    const result = await this.#pool.query<{
      id: string;
      account_id: string;
      name: string;
      platform: string | null;
      revoked_at: Date | null;
      last_seen_at: Date | null;
    }>(
      `SELECT id, account_id, name, platform, revoked_at, last_seen_at
       FROM devices
       WHERE account_id = $1
       ORDER BY created_at ASC`,
      [accountId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      platform: row.platform,
      revokedAt: row.revoked_at,
      lastSeenAt: row.last_seen_at,
    }));
  }

  async renameDevice(
    accountId: string,
    deviceId: string,
    name: string,
  ): Promise<DeviceRecord | null> {
    const result = await this.#pool.query<{
      id: string;
      account_id: string;
      name: string;
      platform: string | null;
      revoked_at: Date | null;
      last_seen_at: Date | null;
    }>(
      `UPDATE devices
       SET name = $3
       WHERE account_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING id, account_id, name, platform, revoked_at, last_seen_at`,
      [accountId, deviceId, name],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          name: row.name,
          platform: row.platform,
          revokedAt: row.revoked_at,
          lastSeenAt: row.last_seen_at,
        }
      : null;
  }

  async revokeDevice(accountId: string, deviceId: string): Promise<boolean> {
    return await this.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE devices
         SET revoked_at = now()
         WHERE account_id = $1 AND id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [accountId, deviceId],
      );
      if (!result.rows[0]) return false;
      await client.query(
        `INSERT INTO audit_events (
           id, account_id, device_id, event_type, outcome
         ) VALUES ($1, $2, $3, 'device_revoked', 'success')`,
        [randomUUID(), accountId, deviceId],
      );
      return true;
    });
  }

  async touchDevice(accountId: string, deviceId: string): Promise<boolean> {
    const result = await this.#pool.query<{ id: string }>(
      `UPDATE devices
       SET last_seen_at = now()
       WHERE account_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [accountId, deviceId],
    );
    return result.rows[0] !== undefined;
  }

  async authenticateDevice(
    deviceId: string,
    secret: string,
  ): Promise<DeviceRecord | null> {
    const result = await this.#pool.query<{
      id: string;
      account_id: string;
      name: string;
      platform: string | null;
      token_salt: Buffer;
      token_hash: Buffer;
      revoked_at: Date | null;
      last_seen_at: Date | null;
    }>(
      `SELECT id, account_id, name, platform, token_salt, token_hash,
              revoked_at, last_seen_at
       FROM devices
       WHERE id = $1`,
      [deviceId],
    );
    const row = result.rows[0];
    const secretMatches = await verifyDeviceSecret(
      secret,
      row?.token_salt ?? DUMMY_TOKEN_SALT,
      row?.token_hash ?? DUMMY_TOKEN_HASH,
    );
    if (!row) return null;
    if (row.revoked_at || !secretMatches) {
      await this.#pool.query(
        `INSERT INTO audit_events (
           id, account_id, device_id, event_type, outcome
         ) VALUES ($1, $2, $3, 'device_auth', 'failure')`,
        [randomUUID(), row.account_id, row.id],
      );
      return null;
    }
    const updated = await this.#pool.query<{ last_seen_at: Date }>(
      `UPDATE devices
       SET last_seen_at = now()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING last_seen_at`,
      [deviceId],
    );
    const lastSeenAt = updated.rows[0]?.last_seen_at;
    if (!lastSeenAt) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      platform: row.platform,
      revokedAt: row.revoked_at,
      lastSeenAt,
    };
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
