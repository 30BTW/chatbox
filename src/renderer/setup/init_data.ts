import type { Session, SessionMetaRecord } from '@shared/types'
import { getLogger } from '@/lib/utils'
import { defaultSessionsForCN, defaultSessionsForEN } from '@/packages/initial_data'
import platform from '@/platform'
import storage from '@/storage'
import { sortSessionRecords } from '@/storage/SessionMetaStorage'
import { StorageKeyGenerator } from '@/storage/StoreStorage'
import * as chatStore from '@/stores/chatStore'
import { getSessionMeta } from '@/stores/sessionHelpers'
import { createSessionMetaRecordsFromLegacyList } from '@/utils/session-utils'

const log = getLogger('init-data')

export async function initData() {
  // 恢复孤立的历史会话（session:* 存在但不在列表中的情况）
  await tryRecoverOrphanedSessions()
  await initSessionsIfNeeded()
}

async function initSessionsIfNeeded() {
  const metaStorage = await chatStore.getMetaStorage()
  const total = await metaStorage.getAllTotal()
  if (total > 0) {
    return
  }

  const lang = await platform.getLocale().catch(() => 'en')
  const defaultSessions = lang.startsWith('zh') ? defaultSessionsForCN : defaultSessionsForEN

  for (const session of defaultSessions) {
    await storage.setItemNow(StorageKeyGenerator.session(session.id), session)
  }

  const records = createSessionMetaRecordsFromLegacyList(defaultSessions.map(getSessionMeta))

  await metaStorage.createMany(records)
}

async function tryRecoverOrphanedSessions(): Promise<void> {
  try {
    const allKeys = await storage.getAllKeys()
    const sessionKeys = allKeys.filter(
      (k: string) =>
        k.startsWith('session:') &&
        !k.startsWith('session:new') &&
        !k.startsWith('session:chatbox-chat-demo')
    )

    if (sessionKeys.length === 0) {
      return
    }

    // 获取当前会话列表
    const currentList = await chatStore.listSessionsMeta()
    const currentIds = new Set(currentList.map((s) => s.id))

    // 找到不在当前列表中的孤立会话
    const orphanedKeys = sessionKeys.filter((k: string) => {
      const id = k.replace('session:', '')
      return !currentIds.has(id)
    })

    if (orphanedKeys.length === 0) {
      return
    }

    log.info(`Found ${orphanedKeys.length} orphaned session keys, recovering...`)

    const recoveredRecords: SessionMetaRecord[] = []
    for (const key of orphanedKeys) {
      try {
        const session = await storage.getItem<Session | null>(key, null)
        if (session && session.id) {
          recoveredRecords.push({
            ...getSessionMeta(session),
            sortOrder: Date.now(),
            createdAt: Date.now(),
          })
        }
      } catch (err) {
        log.warn(`Failed to read orphaned session key: ${key}`, err)
      }
    }

    if (recoveredRecords.length === 0) {
      return
    }

    log.info(`Recovered ${recoveredRecords.length} orphaned sessions`)
    // 合并到现有列表（新版 meta storage + 列表缓存）
    const metaStorage = await chatStore.getMetaStorage()
    await metaStorage.createMany(recoveredRecords)
    chatStore.updateSessionListData((items) => sortSessionRecords([...items, ...recoveredRecords]))
  } catch (error) {
    log.error('Failed to recover orphaned sessions:', error)
  }
}
