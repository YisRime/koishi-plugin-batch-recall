# koishi-plugin-batch-recall

[![npm](https://img.shields.io/npm/v/koishi-plugin-batch-recall?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-batch-recall)

批量撤回，基于数据库，可指定撤回某用户的多少条消息，可配置

## 主要功能

- 自动存储消息记录到数据库
- 批量撤回指定用户的消息
- 通过引用快速撤回消息
- 自动清理过期消息
- 可配置的消息存储限制

## 使用方法

### 撤回指定用户的消息

使用以下命令撤回指定用户的消息：

recall userId count

- `<userId>`: 用户的 ID
- `<count>`: 要撤回的消息数量

### 通过引用快速撤回消息

引用要撤回的消息并使用命令，会自动撤回引用的消息。

### 自动清理过期消息

插件会自动清理超过过期时间的消息，无需手动操作。
