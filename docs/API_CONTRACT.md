# API Contract 0.1

## OpenAI 兼容模式

插件会发送：

```http
POST /v1/chat/completions
Authorization: Bearer <api key>
Content-Type: application/json
```

请求体包含 `model`、`messages`、`temperature: 0` 和 `response_format: {"type":"json_object"}`。如果服务端不接受 `response_format`，插件会自动重试一次不带该字段的请求。

模型应返回：

```json
{
  "records": [{"community": "", "starting_price_wan": 0}],
  "missing_fields": [],
  "warnings": [],
  "confidence": 0.9,
  "evidence": {}
}
```

## 中转服务模式（`apiMode: 'relay-package'`）

```http
POST <你填的完整端点>
Content-Type: application/json
Authorization: Bearer <optional relay token>
```

请求体是完整 `auction-page-package`。

> **端点必须填完整**：插件只在地址为空或正好是 `/v1` 时才自动补 `/chat/completions`，
> 其他路径原样发送、不做补全。中转模式请直接填
> `https://你的中转域名/v1/auction/packages` 这类完整地址，否则会打到错误路径。

**响应是同步的**：请求返回的响应体即最终抽取结果，插件不会轮询、也没有 job 概念。
返回结构应与直连模式一致（见上方「OpenAI 兼容模式」的 `records` / `warnings` 等字段）：

```json
{
  "records": [{"community": "", "starting_price_wan": 0}],
  "missing_fields": [],
  "warnings": [],
  "confidence": 0.9,
  "evidence": {}
}
```

⚠️ **不要返回 `{ "job_id": ..., "status": "queued" }` 这类异步排队回执**——插件会把它
当作抽取结果直接解析，最终得到空记录。若确实需要异步处理，请在你的中转服务内部
完成排队与等待，对插件这一侧仍然同步返回结果。

## 密钥保存在哪

- **插件本身不内置、不随包分发任何模型供应商密钥。**
- 直连模式下，使用者填入的 API Key 保存在使用者本机的 `chrome.storage.local`，
  请求时作为 `Authorization: Bearer` 发往所选模型服务商，不会上传到其他第三方。
- 中转模式下，密钥由你的服务端自行保管，插件侧无需配置。
- 服务端（若自建）建议承担：装载 Skill/MD、校验 JSON Schema、字段单位转换与结果持久化 —— 这些当前版本插件不做。
