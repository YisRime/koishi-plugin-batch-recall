import { Context, Schema } from 'koishi'

export const name = 'batch-recall'
export const inject = { required: ['database'] }

/**
 * 批量撤回插件的配置接口
 * @interface MessageManagerConfig
 */
export interface MessageManagerConfig {
  maxMessagesPerUser: number
  maxMessageRetentionHours: number
  cleanupIntervalHours: number
}

export const Config: Schema<MessageManagerConfig> = Schema.object({
  maxMessagesPerUser: Schema.number()
    .description('每个用户最多保存消息数量（条）')
    .default(99)
    .min(0),
  maxMessageRetentionHours: Schema.number()
    .description('消息最长保存时间（小时）')
    .default(24)
    .min(0),
  cleanupIntervalHours: Schema.number()
    .description('自动清理过期消息的时间间隔（小时）')
    .default(24)
    .min(0),
})

declare module 'koishi' {
  interface Tables {
    messages: StoredMessage
  }
}

/**
 * 存储消息的数据结构
 * @interface StoredMessage
 */
interface StoredMessage {
  messageId: string
  userId: string
  channelId: string
  timestamp: number
}

/**
 * 撤回任务的数据结构
 * @interface RecallTask
 */
interface RecallTask {
  controller: AbortController
  total: number
  success: number
  failed: number
}

/**
 * 插件主函数
 * @param ctx Koishi 上下文
 * @param config 插件配置
 */
export function apply(ctx: Context, config: MessageManagerConfig) {
  const pluginLogger = ctx.logger('batch-recall')
  let cleanupTimer: NodeJS.Timeout

  // 功能状态检查
  const features = {
    storeMessages: config.maxMessagesPerUser > 0 || config.maxMessageRetentionHours > 0,
    limitByCount: config.maxMessagesPerUser > 0,
    limitByTime: config.maxMessageRetentionHours > 0,
    autoCleanup: config.cleanupIntervalHours > 0
  }

  // 输出功能状态日志
  function logFeatureStatus() {
    if (!features.storeMessages) {
      pluginLogger.info('消息存储功能已禁用')
      return
    }

    const enabledFeatures = []
    if (features.limitByCount) enabledFeatures.push(`数量限制 (${config.maxMessagesPerUser} 条/用户)`)
    if (features.limitByTime) enabledFeatures.push(`时间限制 (${config.maxMessageRetentionHours} 小时)`)

    pluginLogger.info(`消息存储功能已启用 [${enabledFeatures.join(', ')}]`)

    if (features.autoCleanup) {
      pluginLogger.info(`自动清理已启用 (每 ${config.cleanupIntervalHours} 小时)`)
    } else {
      pluginLogger.info('自动清理已禁用')
    }
  }

  // 扩展数据库模型
  ctx.model.extend('messages', {
    messageId: 'string',
    userId: 'string',
    channelId: 'string',
    timestamp: 'integer',
  }, {
    primary: 'messageId',
    indexes: [
      ['channelId', 'userId'],
      ['timestamp'],
    ],
  })

  /**
   * 清理所有过期消息
   */
  async function cleanupAllExpiredMessages(): Promise<void> {
    try {
      const currentTimestamp = Date.now()
      const cleanupTasks = []

      // 清理超过保存时间的消息
      if (features.limitByTime) {
        const expirationTimestamp = currentTimestamp - config.maxMessageRetentionHours * 3600000
        cleanupTasks.push(
          ctx.database.remove('messages', {
            timestamp: { $lt: expirationTimestamp }
          })
        )
      }

      // 清理超过数量限制的消息
      if (features.limitByCount) {
        const userChannelPairs = await ctx.database
          .select('messages')
          .groupBy(['userId', 'channelId'])
          .execute()

        for (const pair of userChannelPairs) {
          const userMessages = await ctx.database
            .select('messages')
            .where({ channelId: pair.channelId, userId: pair.userId })
            .orderBy('timestamp', 'desc')
            .execute()

          if (userMessages.length > config.maxMessagesPerUser) {
            const messagesToRemove = userMessages
              .slice(config.maxMessagesPerUser)
              .map(msg => msg.messageId)

            if (messagesToRemove.length > 0) {
              cleanupTasks.push(
                ctx.database.remove('messages', {
                  messageId: { $in: messagesToRemove }
                })
              )
            }
          }
        }
      }
      // 执行清理并记录结果
      const results = await Promise.all(cleanupTasks)
      const totalRemoved = results.reduce((sum, result) => sum + (result?.matched || 0), 0)

      if (totalRemoved > 0) {
        pluginLogger.info(`成功清理 ${totalRemoved} 条过期消息`)
      } else {
        pluginLogger.debug('没有发现需要清理的过期消息')
      }
    } catch (error) {
      pluginLogger.error(`清理过期消息失败: ${error.message}`)
    }
  }

  /**
   * 启动定时清理任务
   */
  function startCleanupTask() {
    if (!features.storeMessages || !features.autoCleanup) {
      return
    }

    if (cleanupTimer) {
      clearInterval(cleanupTimer)
    }
    cleanupAllExpiredMessages()

    const intervalMs = config.cleanupIntervalHours * 3600 * 1000
    cleanupTimer = setInterval(cleanupAllExpiredMessages, intervalMs)
  }

  /**
   * 处理消息事件，保存消息记录
   * @param session 会话对象
   */
  const handleMessageEvent = async (session) => {
    if (!session?.messageId) return
    await ctx.database.create('messages', {
      messageId: session.messageId,
      userId: session.userId,
      channelId: session.channelId,
      timestamp: Date.now(),
    }).catch(error =>
      pluginLogger.error(`保存消息记录失败: ${error.message}`)
    )
  }

  // 启用消息存储才注册监听器
  if (features.storeMessages) {
    ctx.on('message', handleMessageEvent)
    ctx.on('send', handleMessageEvent)

    ctx.on('ready', () => {
      logFeatureStatus()
      startCleanupTask()
    })

    ctx.on('dispose', () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer)
        pluginLogger.info('已停止自动清理任务')
      }
    })
  } else {
    ctx.on('ready', logFeatureStatus)
  }

  const activeRecallTasks = new Map<string, Set<RecallTask>>()

  /**
   * 撤回指定消息
   * @param session 会话对象
   * @param messageIds 要撤回的消息ID数组
   * @returns 撤回操作的结果统计
   */
  async function recallMessages(session, messageIds: string[]) {
    const recallResults = await Promise.allSettled(messageIds.map(async id => {
      await session.bot.deleteMessage(session.channelId, id)
      await ctx.database.remove('messages', { messageId: id })
    }))

    const successCount = recallResults.filter(r => r.status === 'fulfilled').length
    const failedCount = recallResults.filter(r => r.status === 'rejected').length
    return { success: successCount, failed: failedCount }
  }

  /**
   * 获取需要撤回的消息
   * @param channelId 频道ID
   * @param options 查询选项，包括用户和数量
   * @returns 符合条件的消息列表
   */
  async function fetchMessagesToRecall(channelId: string, options: { user?: string, count?: number }) {
    const targetUserId = options.user?.replace(/^<at:(.+)>$/, '$1')

    // 查询符合条件的消息
    return ctx.database
      .select('messages')
      .where({
        channelId,
        ...(targetUserId && { userId: targetUserId })
      })
      .orderBy('timestamp', 'desc')
      .limit(Math.max(1, Number(options.count) || 1))
      .execute()
  }

  // 注册撤回命令
  const recall = ctx.command('recall', '撤回消息')
    .option('user', '-u <user> 撤回指定用户的消息', { authority: 3 })
    .option('number', '-n <number> 撤回消息数量', { authority: 3, fallback: 1 })
    .action(async ({ session, options }) => {
      try {
        // 处理引用消息的撤回
        const quotedMessages = Array.isArray(session.quote) ? session.quote : [session.quote].filter(Boolean)
        if (quotedMessages?.length) {
          const { success, failed } = await recallMessages(
            session,
            quotedMessages.map(q => q.id || q.messageId)
          )
          return failed ? `撤回完成：成功 ${success} 条，失败 ${failed} 条` : ''
        }

        if (!features.storeMessages && !session.quote) {
          return '消息存储功能已禁用，只能撤回引用消息'
        }

        // 创建新的撤回任务
        const channelRecallTasks = activeRecallTasks.get(session.channelId) || new Set()
        const recallOperation: RecallTask = {
          controller: new AbortController(),
          total: 0,
          success: 0,
          failed: 0
        }

        // 将新任务添加到任务集合中
        channelRecallTasks.add(recallOperation)
        activeRecallTasks.set(session.channelId, channelRecallTasks)

        // 获取需要撤回的消息
        const messagesToRecall = await fetchMessagesToRecall(session.channelId, {
          user: options.user,
          count: options.number
        })

        recallOperation.total = messagesToRecall.length

        // 逐一撤回消息
        for (const message of messagesToRecall) {
          // 如果任务被中止，则退出循环
          if (recallOperation.controller.signal.aborted) break

          const { success, failed } = await recallMessages(session, [message.messageId])
          recallOperation.success += success
          recallOperation.failed += failed

          // 添加延迟以避免频率限制
          await new Promise(resolve => setTimeout(resolve, 500))
        }

        // 任务完成后清理任务记录
        channelRecallTasks.delete(recallOperation)
        if (!channelRecallTasks.size) {
          activeRecallTasks.delete(session.channelId)
        }

        return recallOperation.failed
          ? `撤回完成：成功 ${recallOperation.success} 条，失败 ${recallOperation.failed} 条`
          : ''
      } catch (error) {
        pluginLogger.error(`撤回操作失败: ${error}`)
        return '撤回失败'
      }
    })

    // 注册停止撤回命令
  recall.subcommand('.stop', '停止撤回操作')
    .action(async ({ session }) => {
      const channelRecallTasks = activeRecallTasks.get(session.channelId)
      if (!channelRecallTasks || !channelRecallTasks.size) {
        return '没有正在进行的撤回操作'
      }

      // 中止所有撤回任务
      for (const task of channelRecallTasks) {
        task.controller.abort()
      }

      const taskCount = channelRecallTasks.size
      activeRecallTasks.delete(session.channelId)
      return `已停止${taskCount}个撤回操作`
    })
}
