# koishi-plugin-batch-recall

[![npm](https://img.shields.io/npm/v/koishi-plugin-batch-recall?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-batch-recall)

基于数据库的高阶撤回，支持撤回某用户的几条消息

## 主要功能

- **消息记录存储**
  - 支持多种消息记录模式
  - 支持白名单群组配置
  - 自动存储消息记录到数据库
  - 可配置每用户最大保存消息数量
  - 可配置消息最大保存时间

- **批量撤回功能**
  - 支持撤回当前会话中指定用户的消息
  - 支持通过引用快速撤回消息
  - 支持中止正在进行的撤回任务

- **自动管理功能**
  - 自动清理过期消息
  - 自动清理超过数量限制的消息

## 配置说明

### 基础配置

| 配置项 | 类型 | 默认值 | 说明 |
|-------|-----|-------|------|
| recordMode | 枚举 | recordWhitelisted | 消息记录模式：recordNone(不记录)、recordWhitelisted(仅记录白名单)、mixedMode(混合模式) |
| whitelistedChannels | 字符串数组 | [] | 白名单群组ID列表 |
| maxMessagesPerUser | 数字 | 99 | 每用户最大保存消息数量 |
| maxMessageRetentionHours | 数字 | 24 | 消息最大保存时间(小时) |
| cleanupIntervalHours | 数字 | 24 | 自动清理执行间隔(小时) |

## 使用方法

基本命令: `recall [选项]`

| 选项 | 说明 |
|------|------|
| -u, --user \<user\> | 撤回指定用户的消息 |
| -n, --number \<number\> | 撤回消息数量，默认为1条 |

停止撤回操作: `recall.stop`
