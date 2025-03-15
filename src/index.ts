import { Context, Schema } from 'koishi'

export const name = 'batch-recall'
export const inject = { required: ['database'] }

/**
 * 消息记录模式枚举
 * @enum {string}
 */
export enum RecordMode {
  RecordWhitelisted = 'recordWhitelisted',
  MixedMode = 'mixedMode',
  RecordNone = 'recordNone'
}

/**
 * 消息存储结构接口
 * @interface Message
 */
interface Message {
  messageId: string
  userId: string
  channelId: string
  timestamp: number
}

/**
 * 撤回任务接口
 * @interface RecallTask
 */
interface RecallTask {
  controller: AbortController
  total: number
  success: number
  failed: number
}

/**
 * 插件配置接口
 * @interface Config
 */
export interface Config {
  recordMode: RecordMode
  whitelistedChannels: string[]
  maxMessagesPerUser?: number
  maxMessageRetentionHours?: number
  cleanupIntervalHours?: number
}

// 扩展Koishi表结构
declare module 'koishi' {
  interface Tables {
    messages: Message
  }
}

/**
 * 插件配置模式
 */
export const Config = Schema.intersect([
  Schema.object({
    recordMode: Schema.union([
      Schema.const(RecordMode.RecordNone).description('1.不记录群组消息'),
      Schema.const(RecordMode.RecordWhitelisted).description('2.仅记录白名单群组消息'),
      Schema.const(RecordMode.MixedMode).description('3.同时记录其他群组发送消息')
    ]).default(RecordMode.RecordNone).description('消息记录模式'),
    maxMessagesPerUser: Schema.number()
      .default(99).min(1).description('最多保存消息数量（条/用户）'),
    maxMessageRetentionHours: Schema.number()
      .default(24).min(1).description('最多保存消息时间（小时）'),
    cleanupIntervalHours: Schema.number()
      .default(24).min(1).description('自动清理过期消息时间（小时）'),
    whitelistedChannels: Schema.array(String).default([]).description('白名单群组ID'),
    }).description('消息记录与存储配置'),
])

/**
 * 插件主函数
 * @param ctx - Koishi上下文
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('batch-recall')
  let cleanupTimer: NodeJS.Timeout

  // 存储功能状态
  const isStorageEnabled = config.recordMode !== RecordMode.RecordNone
  // 活动撤回任务映射表
  const activeRecallTasks = new Map<string, Set<RecallTask>>()

  /**
   * 初始化数据库模型
   * @returns {void}
   */
  function initializeDatabase() {
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
  }

  /**
   * 消息保存逻辑
   * @param {any} session - 会话对象
   * @param {'message'|'send'} eventType - 事件类型
   * @returns {Promise<void>}
   */
  async function saveMessage(session, eventType: 'message' | 'send' = 'message') {
    if (!session?.messageId) return

    const isWhitelisted = config.whitelistedChannels.includes(session.channelId)
    // 根据不同模式判断是否保存消息
    if (
      (config.recordMode === RecordMode.RecordWhitelisted && !isWhitelisted) ||
      (config.recordMode === RecordMode.MixedMode && !isWhitelisted && eventType !== 'send')
    ) {
      return
    }

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

  /**
   * 撤回消息功能
   * @param {any} session - 会话对象
   * @param {string[]} messageIds - 要撤回的消息ID数组
   * @returns {Promise<{success: number, failed: number}>} - 撤回结果
   */
  async function recallMessages(session, messageIds: string[]) {
    const results = await Promise.allSettled(messageIds.map(async id => {
      await session.bot.deleteMessage(session.channelId, id)
      if (isStorageEnabled) {
        await ctx.database.remove('messages', { messageId: id })
      }
    }))

    return {
      success: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length
    }
  }

  /**
   * 查找需要撤回的消息
   * @param {any} session - 会话对象
   * @param {any} options - 查找选项
   * @returns {Promise<Message[]>} - 找到的消息列表
   */
  async function findMessagesToRecall(session, options) {
    const userId = options.user?.replace(/^<at:(.+)>$/, '$1')
    const count = Math.max(1, Number(options.number) || 1)

    const query = { channelId: session.channelId }
    if (userId) query['userId'] = userId

    return ctx.database
      .select('messages')
      .where(query)
      .orderBy('timestamp', 'desc')
      .limit(count)
      .execute()
  }

  /**
   * 按时间清理过期消息
   * @returns {Promise<number>} - 清理的消息数量
   */
  async function cleanupByTime() {
    const expirationTime = Date.now() - config.maxMessageRetentionHours * 3600000
    const result = await ctx.database.remove('messages', {
      timestamp: { $lt: expirationTime }
    })
    return result?.matched || 0
  }

  /**
   * 按用户消息数量清理
   * @returns {Promise<number>} - 清理的消息数量
   */
  async function cleanupByCount() {
    let totalRemoved = 0
    // 获取所有用户-频道对
    const pairs = await ctx.database
      .select('messages')
      .groupBy(['userId', 'channelId'])
      .execute()

    for (const {userId, channelId} of pairs) {
      const messages = await ctx.database
        .select('messages')
        .where({ channelId, userId })
        .orderBy('timestamp', 'desc')
        .execute()

      if (messages.length <= config.maxMessagesPerUser) continue

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
   * 执行完整的消息清理
   * @returns {Promise<void>}
   */
  async function runCleanup() {
    try {
      // 并行执行两种清理
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
   * 设置撤回命令
   * @returns {void}
   */
  function setupRecallCommand() {
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

          if (!isStorageEnabled) {
            return '已禁用消息存储，只能撤回引用消息'
          }
          // 创建新的撤回任务
          const channelTasks = activeRecallTasks.get(session.channelId) || new Set()
          const task: RecallTask = {
            controller: new AbortController(),
            total: 0, success: 0, failed: 0
          }

          channelTasks.add(task)
          activeRecallTasks.set(session.channelId, channelTasks)

          const messages = await findMessagesToRecall(session, options)
          task.total = messages.length

          if (messages.length === 0) {
            channelTasks.delete(task)
            if (channelTasks.size === 0) activeRecallTasks.delete(session.channelId)
            return '未找到可撤回的消息'
          }

          for (const message of messages) {
            if (task.controller.signal.aborted) break

            const result = await recallMessages(session, [message.messageId])
            task.success += result.success
            task.failed += result.failed

            await new Promise(resolve => setTimeout(resolve, 1000))
          }

          channelTasks.delete(task)
          if (channelTasks.size === 0) activeRecallTasks.delete(session.channelId)

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

        for (const task of tasks) task.controller.abort()

        const count = tasks.size
        activeRecallTasks.delete(session.channelId)
        return `已停止${count}个撤回操作`
      })
  }

  /**
   * 启动定时清理任务
   * @returns {void}
   */
  function startCleanupSchedule() {
    runCleanup()
    // 设置定时清理
    const interval = config.cleanupIntervalHours * 3600 * 1000
    cleanupTimer = setInterval(runCleanup, interval)
    logger.info(`已启用自动清理（${config.cleanupIntervalHours} 小时）`)
  }

  /**
   * 显示插件状态信息
   * @returns {void}
   */
  function logPluginStatus() {
    if (isStorageEnabled) {
      // 输出配置信息
      const storageInfo = `${config.maxMessageRetentionHours} 小时 & ${config.maxMessagesPerUser} 条/用户`;
      logger.info(`已启用消息存储（${storageInfo}）`);
    } else {
    }
  }

  // 设置撤回命令
  setupRecallCommand()
  // 仅在启用存储时执行相关初始化
  if (isStorageEnabled) {
    // 初始化数据库
    initializeDatabase()
    // 监听消息事件 - 只有启用存储功能时才监听
    ctx.on('message', session => saveMessage(session, 'message'))
    ctx.on('send', session => saveMessage(session, 'send'))
    // 当Koishi准备就绪，启动清理任务
    ctx.on('ready', () => {
      logPluginStatus()
      startCleanupSchedule()
    })
    // 插件卸载时清理数据库
    ctx.on('dispose', async () => {
      if (cleanupTimer) {
        clearInterval(cleanupTimer)
        logger.info('已停止自动清理')
      }

      try {
        await ctx.database.drop('messages')
        logger.info('已删除消息记录表')
      } catch (error) {
        logger.error(`删除消息记录表失败: ${error.message}`)
      }
    })
  } else {
  }
}
