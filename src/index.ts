import { Context, Schema } from 'koishi'

export const name = 'batch-recall'
export const inject = { required: ['database'] }

/**
 * 插件配置接口
 * @interface Config
 */
export interface Config {
  maxMessagesPerUser: number
  maxMessageRetentionHours: number
  cleanupIntervalHours: number
}

/**
 * 插件配置模式
 */
export const Config = Schema.object({
  maxMessagesPerUser: Schema.number()
    .description('最多保存消息数量（条/用户）')
    .default(99)
    .min(0),
  maxMessageRetentionHours: Schema.number()
    .description('最多保存消息时间（小时）')
    .default(24)
    .min(0),
  cleanupIntervalHours: Schema.number()
    .description('自动清理过期消息时间（小时）')
    .default(24)
    .min(0)
}).description('基础配置')

// 类型定义
declare module 'koishi' {
  interface Tables {
    messages: Message
  }
}

/**
 * 消息存储结构
 * @interface Message
 */
interface Message {
  messageId: string
  userId: string
  channelId: string
  timestamp: number
}

/**
 * 撤回任务结构
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
 * @param ctx Koishi上下文
 * @param config 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('batch-recall')
  let cleanupTimer: NodeJS.Timeout

  /**
   * 快速检查功能状态
   */
  const features = {
    storeMessages: config.maxMessagesPerUser > 0 || config.maxMessageRetentionHours > 0,
    limitByCount: config.maxMessagesPerUser > 0,
    limitByTime: config.maxMessageRetentionHours > 0,
    autoCleanup: config.cleanupIntervalHours > 0
  }

  // 不启用任何功能时直接返回
  if (!features.storeMessages) {
    logger.info('消息存储已禁用')
    return
  }

  // 数据库模型初始化
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
   * 保存消息到数据库
   * @param session 会话对象
   * @returns {Promise<void>}
   */
  async function saveMessage(session) {
    if (!session?.messageId) return

    try {
      await ctx.database.create('messages', {
        messageId: session.messageId,
        userId: session.userId,
        channelId: session.channelId,
        timestamp: Date.now(),
      })
    } catch (error) {
      logger.error(`保存消息失败: ${error.message}`)
    }
  }

  // 启用消息存储事件监听
  ctx.on('message', saveMessage)
  ctx.on('send', saveMessage)

  /**
   * 按时间清理过期消息
   * @returns {Promise<number>} 清理的消息数量
   */
  async function cleanupByTime() {
    if (!features.limitByTime) return 0

    const expirationTime = Date.now() - config.maxMessageRetentionHours * 3600000
    const result = await ctx.database.remove('messages', {
      timestamp: { $lt: expirationTime }
    })
    return result?.matched || 0
  }

  /**
   * 按用户消息数量清理
   * @returns {Promise<number>} 清理的消息数量
   */
  async function cleanupByCount() {
    if (!features.limitByCount) return 0

    let totalRemoved = 0
    // 获取所有用户-频道对
    const pairs = await ctx.database
      .select('messages')
      .groupBy(['userId', 'channelId'])
      .execute()

    for (const {userId, channelId} of pairs) {
      // 获取该用户在该频道的所有消息，按时间降序
      const messages = await ctx.database
        .select('messages')
        .where({ channelId, userId })
        .orderBy('timestamp', 'desc')
        .execute()

      if (messages.length <= config.maxMessagesPerUser) continue
      // 删除超出限制的旧消息
      const messagesToRemove = messages
        .slice(config.maxMessagesPerUser)
        .map(msg => msg.messageId)

      if (messagesToRemove.length) {
        const result = await ctx.database.remove('messages', {
          messageId: { $in: messagesToRemove }
        })
        totalRemoved += result?.matched || 0
      }
    }

    return totalRemoved
  }

  /**
   * 执行全面清理
   * @returns {Promise<void>}
   */
  async function runCleanup() {
    try {
      const [timeRemoved, countRemoved] = await Promise.all([
        cleanupByTime(),
        cleanupByCount()
      ])

      const totalRemoved = timeRemoved + countRemoved
      if (totalRemoved > 0) {
        logger.info(`清理完成: 已移除 ${totalRemoved} 条消息`)
      }
    } catch (error) {
      logger.error(`清理失败: ${error.message}`)
    }
  }

  /**
   * 启动定时清理
   */
  function startCleanupSchedule() {
    if (!features.autoCleanup) return
    // 立即执行一次
    runCleanup()
    // 设置定时任务
    const interval = config.cleanupIntervalHours * 3600 * 1000
    cleanupTimer = setInterval(runCleanup, interval)

    logger.info(`已启用自动清理（ ${config.cleanupIntervalHours} 小时）`)
  }

  /** 活动撤回任务映射表 */
  const activeRecallTasks = new Map<string, Set<RecallTask>>()

  /**
   * 撤回指定消息
   * @param session 会话对象
   * @param messageIds 要撤回的消息ID数组
   * @returns {Promise<{success: number, failed: number}>} 撤回结果
   */
  async function recallMessages(session, messageIds: string[]) {
    const results = await Promise.allSettled(messageIds.map(async id => {
      await session.bot.deleteMessage(session.channelId, id)
      await ctx.database.remove('messages', { messageId: id })
    }))

    return {
      success: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length
    }
  }

  /**
   * 查找需要撤回的消息
   * @param session 会话对象
   * @param options 撤回选项
   * @returns {Promise<Message[]>} 消息列表
   */
  async function findMessagesToRecall(session, options) {
    const userId = options.user?.replace(/^<at:(.+)>$/, '$1')
    const count = Math.max(1, Number(options.count) || 1)

    const query = { channelId: session.channelId }
    if (userId) query['userId'] = userId

    return ctx.database
      .select('messages')
      .where(query)
      .orderBy('timestamp', 'desc')
      .limit(count)
      .execute()
  }

  // 注册撤回命令
  const recall = ctx.command('recall', '撤回消息', { authority: 2 })
    .option('user', '-u <user> 撤回指定用户的消息')
    .option('number', '-n <number> 撤回消息数量', { fallback: 1 })
    .usage('撤回当前会话中指定数量的消息，可以通过引用消息或指定用户和数量进行撤回')
    .example('recall -u @用户 -n 10 - 撤回指定用户的10条最新消息')
    .action(async ({ session, options }) => {
      try {
        // 处理引用消息的撤回
        const quotedMessages = Array.isArray(session.quote)
          ? session.quote
          : [session.quote].filter(Boolean)

        if (quotedMessages?.length) {
          const { success, failed } = await recallMessages(
            session,
            quotedMessages.map(q => q.id || q.messageId)
          )
          return failed ? `撤回完成：成功 ${success} 条，失败 ${failed} 条` : ''
        }

        if (!features.storeMessages) {
          return '已禁用消息存储，只能撤回引用消息'
        }
        // 创建新的撤回任务
        const channelTasks = activeRecallTasks.get(session.channelId) || new Set()
        const task: RecallTask = {
          controller: new AbortController(),
          total: 0, success: 0, failed: 0
        }
        // 注册任务
        channelTasks.add(task)
        activeRecallTasks.set(session.channelId, channelTasks)
        // 获取并撤回消息
        const messages = await findMessagesToRecall(session, options)
        task.total = messages.length

        if (messages.length === 0) {
          channelTasks.delete(task)
          if (channelTasks.size === 0) activeRecallTasks.delete(session.channelId)
          return '未找到可撤回的消息'
        }
        // 逐一撤回消息
        for (const message of messages) {
          if (task.controller.signal.aborted) break

          const result = await recallMessages(session, [message.messageId])
          task.success += result.success
          task.failed += result.failed

          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        // 清理任务
        channelTasks.delete(task)
        if (channelTasks.size === 0) activeRecallTasks.delete(session.channelId)
        // 返回结果
        return task.failed
          ? `撤回完成：成功 ${task.success} 条，失败 ${task.failed} 条`
          : ''
      } catch (error) {
        logger.error(`撤回失败: ${error}`)
        return '撤回操作失败'
      }
    })

  // 停止撤回命令
  recall.subcommand('.stop', '停止撤回操作')
    .action(({ session }) => {
      const tasks = activeRecallTasks.get(session.channelId)
      if (!tasks?.size) return '没有正在进行的撤回操作'
      // 中止所有任务
      for (const task of tasks) task.controller.abort()

      const count = tasks.size
      activeRecallTasks.delete(session.channelId)
      return `已停止${count}个撤回操作`
    })

  /**
   * 当Koishi准备就绪时的处理
   */
  ctx.on('ready', () => {
    // 输出状态信息
    let storageInfo = '';
    if (features.limitByTime) storageInfo += ` ${config.maxMessageRetentionHours} 小时`;
    if (features.limitByTime && features.limitByCount) storageInfo += ' &';
    if (features.limitByCount) storageInfo += ` ${config.maxMessagesPerUser} 条/用户`;
    logger.info(`已启用消息存储（${storageInfo}）`);
    // 启动定时清理
    startCleanupSchedule()
  })

  /**
   * 当插件被卸载时的清理工作
   */
  ctx.on('dispose', async () => {
    // 清理定时器
    if (cleanupTimer) {
      clearInterval(cleanupTimer)
      logger.info('已停止自动清理')
    }
    // 清理数据表
    try {
      await ctx.database.drop('messages')
      logger.info('已删除消息记录表')
    } catch (error) {
      logger.error(`删除消息记录表失败: ${error.message}`)
    }
  })
}
