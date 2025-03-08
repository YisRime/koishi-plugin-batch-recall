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
}

export const Config: Schema<MessageManagerConfig> = Schema.object({
  maxMessagesPerUser: Schema.number()
    .description('每个用户最多保存消息（条）')
    .default(99)
    .min(0),
  maxMessageRetentionHours: Schema.number()
    .description('消息最长保存时间（小时）')
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
   * 清理过期消息
   * @param channelId 频道ID
   * @param userId 用户ID
   * @returns Promise 表示清理操作的结果
   */
  async function removeExpiredMessages(channelId: string, userId: string): Promise<void> {
    const cleanupTasks = []
    const currentTimestamp = Date.now()

    // 清理超过保存时间的消息
    if (config.maxMessageRetentionHours > 0) {
      const expirationTimestamp = currentTimestamp - config.maxMessageRetentionHours * 3600000
      cleanupTasks.push(
        ctx.database.remove('messages', {
          channelId,
          timestamp: { $lt: expirationTimestamp }
        })
      )
    }

    // 清理超过数量限制的消息
    if (config.maxMessagesPerUser > 0) {
      const userMessages = await ctx.database
        .select('messages')
        .where({ channelId, userId })
        .orderBy('timestamp', 'desc')
        .limit(config.maxMessagesPerUser + 1)
        .execute()

      if (userMessages.length > config.maxMessagesPerUser) {
        const messagesToRemove = userMessages.slice(config.maxMessagesPerUser).map(msg => msg.messageId)
        cleanupTasks.push(
          ctx.database.remove('messages', {
            messageId: { $in: messagesToRemove }
          })
        )
      }
    }

    await Promise.all(cleanupTasks).catch(error =>
      pluginLogger.error(`清理过期消息失败: ${error.message}`))
  }

  // 存储进行中的撤回任务
  const activeRecallTasks = new Map<string, Set<RecallTask>>()

  /**
   * 处理消息事件，保存消息记录并清理过期消息
   * @param session 会话对象
   */
  const handleMessageEvent = async (session) => {
    if (!session?.messageId) return

    // 存储消息并清理过期消息
    await ctx.database.create('messages', {
      messageId: session.messageId,
      userId: session.userId,
      channelId: session.channelId,
      timestamp: Date.now(),
    }).then(() => removeExpiredMessages(session.channelId, session.userId))
  }

  // 监听消息发送和接收事件
  ctx.on('message', handleMessageEvent)
  ctx.on('send', handleMessageEvent)

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
    .option('user', '-u <user> 撤回指定用户的消息')
    .option('number', '-n <number> 撤回消息数量', { fallback: 1 })
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
