import { countLegacyCheckinCreds, migrateCheckinCreds } from './checkin'
import { countLegacyPoolCreds, migratePoolCreds } from './wbPool'
import { countLegacyMmCreds, migrateMmCreds } from './mmPool'
import { countLegacyTokenCreds, migrateTokenCreds } from './tokenPool'
import { hasLegacyEpicAuth, migrateEpicAuth } from './freeGames'
import { countLegacyMailCreds, migrateMailCreds } from './mail'
import { hasLegacyTmdbKey, migrateTmdbKey } from './watch'

/**
 * 运营凭据一次性迁移（v0.1.470）：470 前运营凭据（签到单账号/WorkBuddy 池/
 * MiniMax 池/令牌池/Epic 授权/邮箱凭据/邮箱 OAuth 客户端/TMDB Key）是保险箱
 * 主密码加密的；470 起改设备本地密钥加密。用户下一次成功解锁时由 App 调用
 * migrateAllOperationalCreds 把旧密文静默迁完，之后这些功能永不再要密码。
 *
 * - 幂等：已迁的（本地格式）跳过，重复调用只处理剩余旧密文。
 * - API Key 账户（state.accounts 的 encryptedKey）不在范围内，纹丝不动。
 * - 解不开的（密码不对/损坏）跳过并计数，不抛错打断解锁流程。
 */

export function countLegacyOperationalCreds(): number {
  return countLegacyCheckinCreds()
    + countLegacyPoolCreds()
    + countLegacyMmCreds()
    + countLegacyTokenCreds()
    + (hasLegacyEpicAuth() ? 1 : 0)
    + countLegacyMailCreds()
    + (hasLegacyTmdbKey() ? 1 : 0)
}

export function hasLegacyOperationalCreds(): boolean {
  return countLegacyOperationalCreds() > 0
}

export interface CredMigrationResult { migrated: number; remaining: number }

export async function migrateAllOperationalCreds(pwd: string): Promise<CredMigrationResult> {
  let migrated = 0
  const steps: (() => Promise<number>)[] = [
    () => migrateCheckinCreds(pwd),
    () => migratePoolCreds(pwd),
    () => migrateMmCreds(pwd),
    () => migrateTokenCreds(pwd),
    () => migrateEpicAuth(pwd),
    () => migrateMailCreds(pwd),
    () => migrateTmdbKey(pwd),
  ]
  for (const step of steps) {
    try { migrated += await step() } catch { /* 单个存储失败不阻断其余 */ }
  }
  return { migrated, remaining: countLegacyOperationalCreds() }
}
