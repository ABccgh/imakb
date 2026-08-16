# wiki_to_ima — Wiki 网站 → 腾讯 IMA 知识库

DSH 动态 Cordis 插件(Host 半部),注册工具 `wiki_to_ima`:把任意 Wiki 网站的全部页面批量导入或更新到腾讯 IMA 知识库。

核心思路:**页面发现在本机,内容抓取在 IMA 服务端** —— `import_urls` 由 IMA 服务器去抓取网页并解析入库,因此即使本机 IP 被目标站点反爬拦截(如 Cloudflare),导入通道依然可用。

## 功能

- **页面发现**:本机可访问时站内 BFS;被反爬拦截且提供浏览器 cookie 时经 IMA 导入 `allpages` JSON 回读全站清单;也可直接传 `urls` 显式列表
- **知识库自动化**:传 `kb_id` 直接使用;或传 `kb_name`,按名字查找已有知识库,**没有则自动创建**(个人知识库)
- **文件夹**:传 `folder_name` 自动创建(或复用同名)文件夹并全部导入其中;`folder_id` 直通;不传则导入根目录
- **分类页过滤**:默认排除编辑/历史/登录/文件/模板/命名空间等非内容页(含中文 MediaWiki 命名空间),可用 `include`/`exclude` 正则调整
- **更新模式** (`update: true`,需浏览器 cookie):
  - 给每个 URL 追加无害参数 `ima_refresh=<时间戳>` 破 IMA 服务端同 URL 缓存,确保真正重新抓取
  - 轮询确认新条目在知识库中出现后,才删除旧条目(识别"已解析标题"与"未解析 URL 标题"两种形态,含同标题去重,按文件夹作用域)——失败或校验超时保留旧内容(`kept`),不丢数据
  - token 过期自动用 refresh_token 刷新后重试
- **复查** (`review_ms`):导入结束后核对每个被受理页面的 `media_id` 是否真正入库,缺失的自动换新 URL 参数重导一轮(`review_retry`),报告 `reviewed`/`missing`

## 加载到 DSH

1. 把本文件从 `return {` 开始到结尾的内容作为 `code.host` 交给动态插件工具 `cordis_define`(新插件给 3–6 位小写字母前缀,如 `imakb`)
2. 用 `cordis_run` 运行插件
3. 会话内即可直接调用工具 `wiki_to_ima`

依赖服务(Host):`web`、`fs`、`shell`、`tools`、`timer`。

## 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `kb_id` / `kb_name` | 二选一 | 知识库 ID;或知识库名称(自动查找,没有则创建) |
| `client_id` / `api_key` | 必填 | IMA OpenAPI 凭据(`ima-openapi-clientid` / `ima-openapi-apikey`) |
| `url` / `urls` | 二选一 | Wiki 首页 URL(自动发现),或显式 URL 列表 |
| `folder_id` / `folder_name` | 可选 | 目标文件夹(优先 folder_id;folder_name 自动创建) |
| `max_pages` | 可选 | 单次最多处理页数,默认 100(1–1000) |
| `delay_ms` | 可选 | 批次间隔毫秒,默认 500 |
| `update` | 可选 | `true` = 更新模式(需 `ima_uid`/`ima_token`) |
| `verify_ms` | 可选 | 更新模式校验窗口,默认 300000ms |
| `bust_cache` | 可选 | 更新模式追加 `ima_refresh` 破缓存,默认 true |
| `review_ms` | 可选 | 复查窗口,默认 180000ms(0 关闭) |
| `review_retry` | 可选 | 复查缺失自动重导,默认 true |
| `include` / `exclude` | 可选 | URL 正则过滤 |
| `ima_uid` / `ima_token` / `ima_refresh_token` | 更新模式必填 | 浏览器 cookie(IMA-UID / IMA-TOKEN / IMA-REFRESH-TOKEN) |

> ⚠️ 安全:所有凭据一律作为调用参数传入,本插件不保存、不硬编码任何凭据。

## 使用示例

### 首次导入(自动建库 + 建文件夹)

```json
wiki_to_ima({
  "url": "https://minecraft.wiki/",
  "kb_name": "Minecraft Wiki",
  "folder_name": "Minecraft",
  "client_id": "<ima-openapi-clientid>",
  "api_key": "<ima-openapi-apikey>",
  "max_pages": 500,
  "review_ms": 180000
})
```

### 内容更新(已有知识库)

```json
wiki_to_ima({
  "url": "https://minecraft.wiki/",
  "kb_name": "Minecraft Wiki",
  "folder_name": "Minecraft",
  "update": true,
  "client_id": "<ima-openapi-clientid>",
  "api_key": "<ima-openapi-apikey>",
  "ima_uid": "<cookie IMA-UID>",
  "ima_token": "<cookie IMA-TOKEN>",
  "ima_refresh_token": "<cookie IMA-REFRESH-TOKEN>"
})
```

### 显式页面列表

```json
wiki_to_ima({
  "urls": ["https://minecraft.wiki/Redstone", "https://minecraft.wiki/Enchanting"],
  "kb_id": "<knowledge_base_id>",
  "client_id": "...", "api_key": "..."
})
```

## 输出

`mode`、`kb_id`、`created_kb`、`discovered`、`imported`、`updated`、`added`、`kept`、`failed`、`deleted_old`、`reviewed`、`missing`、`folder_id`、`batches`、`mediaIds`、`errors`。

## 实战记录:CK3 Wiki

`https://ck3.paradoxwikis.com/`(Cloudflare 防护)经此插件完整入库:

- 全站 allpages 425 页 → 过滤 43 个消歧义/项目/模板/导航页 → **382 个内容页**
- 首轮导入 382/382 成功,零失败;复查 3/3
- 更新模式实测:token 过期自动刷新后成功删除 9 个积压重复条目,重复归零

## 已知行为与错误码

- `110021` 请求频控 → 自动等待重试
- `220001` URL 导入失败(重定向页或服务端抓取失败;同 URL 短窗口内重复导入也会触发)→ 更新模式会保留旧内容
- `222001` 知识库已删除(如提示建文件夹失败,先到 IMA 回收站恢复或新建知识库)
- `600001/600002` 登录过期 → 自动用 refresh_token 刷新后重试
- IMA 服务端解析是异步的:新条目可能在导入后数分钟才在列表中可见,未解析时条目标题为原始 URL(插件已兼容)
