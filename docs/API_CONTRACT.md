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

## 中转服务模式

```http
POST /v1/auction/packages
Content-Type: application/json
Authorization: Bearer <optional relay token>
```

请求体是完整 `auction-page-package`。

建议响应：

```json
{
  "job_id": "job_123",
  "status": "queued",
  "package_id": "8fd4f0f7-28c0-4f39-84c0-0177befc5f1f"
}
```

## 获取结果

```http
GET /v1/auction/jobs/{job_id}
```

建议最终响应：

```json
{
  "job_id": "job_123",
  "status": "completed",
  "skill_version": "judicial-auction-extractor/0.1",
  "result": {
    "platform": "jd",
    "auction_id": "311290654",
    "fields": {},
    "missing_fields": [],
    "warnings": [],
    "evidence": {}
  }
}
```

服务端负责保存模型供应商密钥、装载 Skill/MD、校验 JSON Schema、字段单位转换和结果持久化。插件不应直接保存模型供应商密钥。
