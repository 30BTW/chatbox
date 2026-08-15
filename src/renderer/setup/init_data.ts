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

// 一次性排序修复标记：已按消息时间修复过会话排序后不再重复执行
const SORT_REPAIR_MARKER = 'chatbox-sort-order-repair-v1'

/**
 * 取会话中最早一条消息的时间戳，用于排序和创建时间展示。
 * 无消息时返回 0，调用方自行 fallback。
 */
function getEarliestMessageTimestamp(session: Session): number {
  let earliest = 0
  for (const msg of session.messages ?? []) {
    if (msg.timestamp && (earliest === 0 || msg.timestamp < earliest)) {
      earliest = msg.timestamp
    }
  }
  for (const thread of session.threads ?? []) {
    for (const msg of thread.messages ?? []) {
      if (msg.timestamp && (earliest === 0 || msg.timestamp < earliest)) {
        earliest = msg.timestamp
      }
    }
  }
  return earliest
}

export async function initData() {
  // 恢复孤立的历史会话（session:* 存在但不在列表中的情况）
  await tryRecoverOrphanedSessions()
  // 一次性修复会话排序时间（早期版本曾把恢复的会话排序时间写成当前时间）
  await repairSessionSortOrders()
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
          // 用最早消息时间作为排序时间，保证恢复后仍按真实时间排序
          const earliest = getEarliestMessageTimestamp(session)
          const sortTime = earliest || Date.now()
          recoveredRecords.push({
            ...getSessionMeta(session),
            sortOrder: sortTime,
            createdAt: sortTime,
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

/**
 * 一次性修复：把所有会话的排序时间（sortOrder/createdAt）改为其最早消息时间戳。
 * 早期版本恢复会话时误用 Date.now()，导致大量会话挤到列表最前且无法按时间排序。
 * 用 storage 标记保证只执行一次，之后不会覆盖用户手动拖拽排序。
 */
async function repairSessionSortOrders(): Promise<void> {
  try {
    const alreadyRepaired = await storage.getItem<boolean>(SORT_REPAIR_MARKER, false)
    if (alreadyRepaired) {
      return
    }

    const allKeys = await storage.getAllKeys()
    const sessionKeys = allKeys.filter(
      (k: string) =>
        k.startsWith('session:') &&
        !k.startsWith('session:new') &&
        !k.startsWith('session:chatbox-chat-demo')
    )

    if (sessionKeys.length === 0) {
      await storage.setItemNow(SORT_REPAIR_MARKER, true)
      return
    }

    const metaStorage = await chatStore.getMetaStorage()
    let fixed = 0
    for (const key of sessionKeys) {
      try {
        const session = await storage.getItem<Session | null>(key, null)
        if (!session?.id) {
          continue
        }
        const earliest = getEarliestMessageTimestamp(session)
        if (!earliest) {
          continue
        }
        const record = await metaStorage.getById(session.id)
        if (!record) {
          continue
        }
        // 与消息时间不一致（相差超过 5 分钟）才修复，避免无谓写入
        if (Math.abs(record.sortOrder - earliest) > 5 * 60 * 1000) {
          await metaStorage.update(session.id, { sortOrder: earliest, createdAt: earliest })
          fixed++
        }
      } catch (err) {
        log.warn(`Failed to repair sort order for session key: ${key}`, err)
      }
    }

    await storage.setItemNow(SORT_REPAIR_MARKER, true)
    if (fixed > 0) {
      log.info(`[SortRepair] Fixed ${fixed} sessions to use message timestamps for ordering`)
      chatStore.updateSessionListData((items) => sortSessionRecords(items))
    }
  } catch (error) {
    log.error('Failed to repair session sort orders:', error)
  }
}
