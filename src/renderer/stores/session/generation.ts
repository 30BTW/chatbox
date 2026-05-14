import { buildContext } from '@shared/context'
import type { AttachmentResolver } from '@shared/context/types'
import { findMessageContext } from '@shared/session/message-forks'
import { type CompactionPoint, createMessage, type Message, type SessionSettings } from '@shared/types'
import type { AgentModeEntrySource } from '@/analytics/agent-mode'
import * as chatStore from '../chatStore'
import { createAttachmentResolver } from './attachment-resolver'
import { createInactiveFork, createNewFork, findMessageLocation } from './forks'
import { withSessionGenerationLock } from './generation-lock'
import { insertMessage, insertMessageAfter, modifyMessage, removeMessage } from './messages'
import { orchestrateGeneration } from './orchestration'
import { orchestratePictureGeneration } from './pictures'
import { uiStore } from '../uiStore'

/**
 * Generate multiple responses in parallel (actually sequential to avoid rate limits)
 * Messages are inserted into session but marked with parallelOutput metadata
 * Key: Each generation removes previous parallel messages from session first,
 * then re-inserts them after generation, so each gets the same context.
 */
export async function generateParallelOutput(
  sessionId: string,
  contextMessages: Message[],
  config: { count: number; interval: number }
): Promise<void> {
  const { count, interval } = config

  // Get the last user message as parent
  const lastUserMessage = contextMessages[contextMessages.length - 1]
  if (!lastUserMessage) return
  const parentMessageId = lastUserMessage.id

  // Generate a unique parallel output ID
  const parallelOutputId = `parallel-${Date.now()}`

  console.log('[ParallelOutput] Starting parallel output', {
    sessionId,
    contextMsgCount: contextMessages.length,
    count,
    lastUserMsgId: parentMessageId,
    parallelOutputId,
  })

  // Initialize parallel output state in uiStore
  uiStore.getState().startParallelOutput(sessionId, parentMessageId, count)

  // Store completed messages temporarily (removed from session during generation)
  const completedMessages: Message[] = []

  // Sequential generation
  for (let i = 0; i < count; i++) {
    console.log(`[ParallelOutput] === Iteration ${i}/${count} ===`)

    // Check if parallel output was cancelled
    const currentState = uiStore.getState().getParallelOutputState(sessionId)
    if (!currentState) {
      console.log(`[ParallelOutput] State cleared for session ${sessionId}, aborting at i=${i}`)
      // Re-insert any messages that were removed
      for (const msg of completedMessages) {
        await insertMessage(sessionId, msg)
      }
      return
    }

    // Update slot to generating
    uiStore.getState().updateParallelSlot(sessionId, i, { status: 'generating' })

    // Remove previously completed parallel messages from session
    // so the next generation sees the same context (just the user message)
    for (const msg of completedMessages) {
      console.log(`[ParallelOutput] Removing previous completed msg: ${msg.id}`)
      await removeMessage(sessionId, msg.id)
    }

    // Create new assistant message
    const assistantMsg = createMessage('assistant', '')
    assistantMsg.generating = true
    assistantMsg.parallelOutputId = parallelOutputId
    assistantMsg.parallelOutputIndex = i

    console.log(`[ParallelOutput] Created assistantMsg-${i}, id: ${assistantMsg.id}`)

    // Insert into session for generate() to work
    await insertMessage(sessionId, assistantMsg)

    // Verify the message was inserted
    const sessionAfterInsert = await chatStore.getSession(sessionId)
    const msgCount = sessionAfterInsert?.messages.length ?? 0
    const msgIds = sessionAfterInsert?.messages.map(m => ({ id: m.id, role: m.role, generating: m.generating })) ?? []
    console.log(`[ParallelOutput] After insert, session has ${msgCount} messages:`, msgIds)

    try {
      // Generate - this will see the same context as the first time
      await generate(sessionId, assistantMsg, { operationType: 'send_message' })

      // Get the completed message from session (it has the full content)
      // Note: generate() updates the message in session, not the passed object
      const session = await chatStore.getSession(sessionId)
      const completedMsg = session?.messages.find((m) => m.id === assistantMsg.id)
      if (!completedMsg) {
        console.error('[ParallelOutput] Message not found after generation', {
          sessionId,
          messageId: assistantMsg.id,
          sessionMessages: session?.messages.map(m => ({ id: m.id, role: m.role, generating: m.generating }))
        })
        throw new Error('Message not found after generation')
      }
      console.log('[ParallelOutput] Generation completed', {
        index: i,
        messageId: completedMsg.id,
        generating: completedMsg.generating,
        contentPartsLength: completedMsg.contentParts?.length,
        hasContent: completedMsg.contentParts?.some(p => p.type === 'text' && p.text)
      })
      completedMessages.push(completedMsg)

      // Update slot status
      uiStore.getState().updateParallelSlot(sessionId, i, {
        message: completedMsg,
        status: 'completed',
      })
    } catch (error) {
      console.error(`[ParallelOutput] Error in iteration ${i}:`, error)
      // Remove the failed message
      await removeMessage(sessionId, assistantMsg.id)
      // Update slot with error
      uiStore.getState().updateParallelSlot(sessionId, i, {
        status: 'error',
        error: (error as Error)?.message || 'Generation failed',
      })
      // Re-insert completed messages
      for (const msg of completedMessages) {
        await insertMessage(sessionId, msg)
      }
      return
    }

    // Wait for interval before next generation
    if (i < count - 1 && interval > 0) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000))
    }
  }

  console.log('[ParallelOutput] All generations done, re-inserting completed messages')
  // Re-insert all completed messages back into session
  for (const msg of completedMessages) {
    const session = await chatStore.getSession(sessionId)
    if (session && !session.messages.find((m) => m.id === msg.id)) {
      await insertMessage(sessionId, msg)
    }
  }
}

/**
 * Accept a parallel output slot and convert it to a normal message
 * Removes other unselected messages from the session
 */
export async function acceptParallelOutputSlot(
  sessionId: string,
  slotIndex: number
): Promise<void> {
  const state = uiStore.getState().getParallelOutputState(sessionId)
  if (!state) return

  const selectedSlot = state.slots[slotIndex]
  if (!selectedSlot?.message) return

  // Get the selected message ID
  const selectedMessageId = selectedSlot.message.id

  // Remove other parallel output messages from session
  for (let i = 0; i < state.slots.length; i++) {
    if (i !== slotIndex) {
      const slot = state.slots[i]
      if (slot.message?.id) {
        await removeMessage(sessionId, slot.message.id)
      }
    }
  }

  // Clear the parallel output markers from the selected message
  const session = await chatStore.getSession(sessionId)
  if (session) {
    const selectedMsg = session.messages.find((m) => m.id === selectedMessageId)
    if (selectedMsg) {
      await modifyMessage(sessionId, {
        ...selectedMsg,
        parallelOutputId: undefined,
        parallelOutputIndex: undefined,
      })
    }
  }

  // Clear parallel output state
  uiStore.getState().cancelParallelOutput(sessionId)
}

/** Internal generation entry point for callers that already hold the session generation lock. */
export async function _generateWithoutSessionLock(
  sessionId: string,
  targetMsg: Message,
  options?: {
    operationType?: 'send_message' | 'regenerate'
    skipAgentModeSuggestion?: boolean
    agentModeEntrySource?: AgentModeEntrySource
    contextMessages?: Message[]
  }
) {
  const session = await chatStore.getSession(sessionId)
  const settings = await chatStore.getSessionSettings(sessionId)
  if (!session || !settings) {
    return
  }

  if (session.type === 'chat' || session.type === undefined) {
    await orchestrateGeneration(sessionId, targetMsg, options)
    return
  }

  await orchestratePictureGeneration(sessionId, targetMsg, session, settings, options)
}

export function generate(
  sessionId: string,
  targetMsg: Message,
  options?: {
    operationType?: 'send_message' | 'regenerate'
    skipAgentModeSuggestion?: boolean
    agentModeEntrySource?: AgentModeEntrySource
  }
) {
  return withSessionGenerationLock(sessionId, () => _generateWithoutSessionLock(sessionId, targetMsg, options))
}

/**
 * Insert and generate a new message below the target message
 * @param sessionId Session ID
 * @param msgId Message ID
 */
async function generateActiveReplyWithoutSessionLock(sessionId: string, msgId: string) {
  const newAssistantMsg = createMessage('assistant', '')
  newAssistantMsg.generating = true // prevent estimating token count before generating done
  await insertMessageAfter(sessionId, newAssistantMsg, msgId)
  await _generateWithoutSessionLock(sessionId, newAssistantMsg, { operationType: 'regenerate' })
}

async function generateInactiveReply(sessionId: string, msgId: string) {
  const newAssistantMsg = createMessage('assistant', '')
  newAssistantMsg.generating = true
  const contextMessages = await createInactiveFork(sessionId, msgId, [newAssistantMsg])

  if (!contextMessages) {
    await insertMessageAfter(sessionId, newAssistantMsg, msgId)
    await _generateWithoutSessionLock(sessionId, newAssistantMsg, { operationType: 'regenerate' })
    return
  }

  await _generateWithoutSessionLock(sessionId, newAssistantMsg, {
    operationType: 'regenerate',
    contextMessages,
  })
}

export async function generateMore(sessionId: string, msgId: string) {
  const session = await chatStore.getSession(sessionId)
  if (!session) {
    return
  }

  // Picture generation has no abort signal yet, so keep it serialized. Chat
  // replies are safe to run concurrently because their message writes are
  // serialized by chatStore and each stream has its own AbortController.
  if (session.type === 'picture') {
    return withSessionGenerationLock(sessionId, () => generateActiveReplyWithoutSessionLock(sessionId, msgId))
  }
  return generateInactiveReply(sessionId, msgId)
}

export function generateMoreInNewFork(sessionId: string, msgId: string) {
  return withSessionGenerationLock(sessionId, async () => {
    await createNewFork(sessionId, msgId)
    await generateActiveReplyWithoutSessionLock(sessionId, msgId)
  })
}

type GenerateMoreFn = (sessionId: string, msgId: string) => Promise<void>

export function regenerateInNewFork(sessionId: string, msg: Message, options?: { runGenerateMore?: GenerateMoreFn }) {
  return withSessionGenerationLock(sessionId, () => regenerateInNewForkWithoutSessionLock(sessionId, msg, options))
}

async function regenerateInNewForkWithoutSessionLock(
  sessionId: string,
  msg: Message,
  options?: { runGenerateMore?: GenerateMoreFn }
) {
  const runGenerateMore = options?.runGenerateMore ?? generateActiveReplyWithoutSessionLock
  const session = await chatStore.getSession(sessionId)
  if (!session) {
    return
  }
  const location = findMessageLocation(session, msg.id)
  if (!location) {
    await _generateWithoutSessionLock(sessionId, msg, { operationType: 'regenerate' })
    return
  }
  // Skip anchored compaction summaries: a summary sits immediately after its
  // boundary and belongs to the shared prefix, so the fork pivot must be the
  // real conversation message before it (forks keyed on a summary id would
  // attach navigation to SummaryMessage and break when it is deleted).
  let previousMessageIndex = location.index - 1
  while (previousMessageIndex >= 0 && location.list[previousMessageIndex].isSummary) {
    previousMessageIndex -= 1
  }
  if (previousMessageIndex < 0) {
    // If target message is the first message, regenerate directly
    await _generateWithoutSessionLock(sessionId, msg, { operationType: 'regenerate' })
    return
  }
  const forkMessage = location.list[previousMessageIndex]
  await createNewFork(sessionId, forkMessage.id)
  return runGenerateMore(sessionId, forkMessage.id)
}

/**
 * Build message context for prompt
 * Thin wrapper over shared buildContext() for backward compatibility
 *
 * @param settings Session settings
 * @param msgs Original message list
 * @param modelSupportToolUseForFile Whether model supports file reading tool (if supported, file content is not directly included)
 * @param optionsOrAdapter Optional configuration object OR legacy storageAdapter (for backward compatibility)
 * @returns Processed message list
 */
export async function genMessageContext(
  settings: SessionSettings,
  msgs: Message[],
  modelSupportToolUseForFile: boolean,
  optionsOrAdapter?:
    | {
        storageAdapter?: { getBlob: (key: string) => Promise<string> }
        compactionPoints?: CompactionPoint[]
      }
    | { getBlob: (key: string) => Promise<string> }
): Promise<Message[]> {
  let storageAdapter: { getBlob: (key: string) => Promise<string> } | undefined
  let compactionPoints: CompactionPoint[] | undefined

  if (optionsOrAdapter) {
    if ('getBlob' in optionsOrAdapter) {
      storageAdapter = optionsOrAdapter
    } else {
      storageAdapter = optionsOrAdapter.storageAdapter
      compactionPoints = optionsOrAdapter.compactionPoints
    }
  }

  const attachmentResolver = storageAdapter
    ? createAttachmentResolverFromAdapter(storageAdapter)
    : createAttachmentResolver()

  return buildContext(msgs, {
    attachmentResolver,
    compactionPoints,
    maxContextMessageCount: settings.maxContextMessageCount,
    modelSupportToolUseForFile,
  })
}

/**
 * Helper to create AttachmentResolver from legacy storageAdapter interface
 * Used by integration tests that pass custom storage adapter
 */
function createAttachmentResolverFromAdapter(adapter: {
  getBlob: (key: string) => Promise<string>
}): AttachmentResolver {
  return {
    async read(id) {
      return adapter.getBlob(id).catch(() => null as string | null)
    },
  }
}

/**
 * Find the thread message list that a message belongs to
 * @param sessionId Session ID
 * @param messageId Message ID
 * @returns The thread message list containing the message
 */
export async function getMessageThreadContext(sessionId: string, messageId: string): Promise<Message[]> {
  const session = await chatStore.getSession(sessionId)
  if (!session) {
    return []
  }
  return findMessageContext(session, messageId)?.list ?? []
}

// Re-export for backward compatibility
export { getSessionWebBrowsing } from './utils'
