/**
 * @module batch-recall
 * @description 支持批量撤回消息的Koishi插件
 */
import { Context, Schema } from 'koishi'

export const name = 'batch-recall'
export const inject = { required: ['database'] }

/**
 * 消息存储结构接口
 * @interface Message
 * @property {string} messageId - 消息的唯一标识符
 * @property {string} userId - 发送消息的用户ID
 * @property {string} channelId - 消息所在的频道ID
 * @property {number} timestamp - 消息的时间戳
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
 * @property {AbortController} controller - 用于中止撤回操作的控制器
 * @property {number} total - 总共需要撤回的消息数量
 * @property {number} success - 成功撤回的消息数量
 * @property {number} failed - 撤回失败的消息数量
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
 * @property {string[]} whitelistedChannels - 允许记录消息的频道ID列表
 * @property {number} [maxMessagesPerUser] - 每个用户最多保存的消息数量
 * @property {number} [maxMessageRetentionHours] - 消息最长保留时间（小时）
 * @property {number} [cleanupIntervalHours] - 自动清理消息的时间间隔（小时）
 */
export interface Config {
  whitelistedChannels: string[]
  maxMessagesPerUser?: number
  maxMessageRetentionHours?: number
  cleanupIntervalHours?: number
}

declare module 'koishi' {
  interface Tables {
    messages: Message
  }
}

/**
 * 插件配置模式定义
 */
export const Config = Schema.object({
  maxMessagesPerUser: Schema.number()
    .default(99).min(1).description('最多保存消息数量（条/用户）'),
  maxMessageRetentionHours: Schema.number()
    .default(24).min(1).description('最多保存消息时间（小时）'),
  cleanupIntervalHours: Schema.number()
    .default(24).min(1).description('自动清理过期消息时间（小时）'),
  whitelistedChannels: Schema.array(String).default([]).description('白名单群组ID'),
}).description('消息记录与存储配置')

/**
 * 插件主函数
 * @param {Context} ctx - Koishi上下文
 * @param {Config} config - 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('batch-recall')
  let cleanupTimer: NodeJS.Timeout
  // 存储功能状态和活动撤回任务映射表
  const isStorageEnabled = config.whitelistedChannels.length > 0
  const activeRecallTasks = new Map<string, Set<RecallTask>>()

  /**
   * 初始化数据库模型
   * @function initializeDatabase
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
   * 保存消息到数据库
   * @function saveMessage
   * @param {any} session - 会话对象
   * @returns {Promise<void>}
   */
  async function saveMessage(session) {
    if (!session?.messageId || !config.whitelistedChannels.includes(session.channelId)) return

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
   * 撤回指定的消息
   * @function recallMessages
   * @param {any} session - 会话对象
   * @param {string[]} messageIds - 要撤回的消息ID数组
   * @returns {Promise<{success: number, failed: number}>} 撤回结果统计
   */
  async function recallMessages(session, messageIds: string[]) {
    const results = await Promise.allSettled(messageIds.map(async id => {
      await session.bot.deleteMessage(session.channelId, id)
      if (isStorageEnabled) await ctx.database.remove('messages', { messageId: id })
    }))

    return {
      success: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length
    }
  }

  /**
   * 查找需要撤回的消息
   * @function findMessagesToRecall
   * @param {any} session - 会话对象
   * @param {any} options - 查询选项
   * @returns {Promise<Message[]>} 找到的消息列表
   */
  async function findMessagesToRecall(session, options) {
    const userId = options.user?.replace(/^<at:(.+)>$/, '$1')
    const count = Math.max(1, Number(options.number) || 1)

    const query: any = { channelId: session.channelId }
    if (userId) query.userId = userId

    return ctx.database
      .select('messages')
      .where(query)
      .orderBy('timestamp', 'desc')
      .limit(count)
      .execute()
  }

  /**
   * 运行消息清理逻辑
   * @function runCleanup
   * @returns {Promise<void>}
   */
  async function runCleanup() {
    try {
      // 按时间清理
      const expirationTime = Date.now() - config.maxMessageRetentionHours * 3600000
      const timeRemoved = (await ctx.database.remove('messages', {
        timestamp: { $lt: expirationTime }
      }))?.matched || 0
      // 按数量清理
      let countRemoved = 0
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
          countRemoved += result?.matched || 0
        }
      }

      const totalRemoved = timeRemoved + countRemoved
      if (totalRemoved > 0) {
        logger.info(`清理完成: 已删除 ${totalRemoved} 条消息记录`)
      }
    } catch (error) {
      logger.error(`清理失败: ${error.message}`)
    }
  }

  // 设置撤回命令
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

        if (!isStorageEnabled) return '已禁用消息存储，只能撤回引用消息'

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

        return task.failed ? `撤回完成：成功 ${task.success} 条，失败 ${task.failed} 条` : ''
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

  // 仅在启用存储时执行相关初始化
  if (isStorageEnabled) {
    initializeDatabase()
    // 监听消息和发送事件
    ctx.on('message', saveMessage)
    ctx.on('send', saveMessage)
    // 启动清理任务
    ctx.on('ready', () => {
      logger.info(`已启用消息存储（${config.maxMessageRetentionHours} 小时 & ${config.maxMessagesPerUser} 条/用户）`)
      runCleanup()
      cleanupTimer = setInterval(runCleanup, config.cleanupIntervalHours * 3600 * 1000)
      logger.info(`已启用自动清理（${config.cleanupIntervalHours} 小时）`)
    })
    // 插件卸载时清理数据库
    ctx.on('dispose', async () => {
      clearInterval(cleanupTimer)
      try {
        await ctx.database.drop('messages')
        logger.info('已停止自动清理并删除消息记录表')
      } catch (error) {
        logger.error(`删除消息记录表失败: ${error.message}`)
      }
    })
  }
}
