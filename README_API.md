# 本地图片接口代理

这是工作台调用你自己的 OpenAI 兼容图片服务时使用的本机代理。它支持图片生成、图生图编辑，并把服务商返回的图片 URL 或 Base64 统一转换为可在画布上使用的数据。代理不保存或打印 API 密钥。

## 启动与前端集成

需要 Node.js 20 或更新版本。单独启动：

```sh
node api-server.mjs
```

默认地址为 `http://127.0.0.1:8787`。环境变量 `WORKBENCH_API_PORT` 可以修改端口。前端与代理同时启动的脚本已提供：`node scripts/dev.mjs`。

前端使用 Vite 时，在 `vite.config.js` 中加入：

```js
export default {
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
};
```

前端向同源 `/api/generate` 发送 JSON。开发来源默认仅允许本机的 5173、5174、4173 和 8787 端口；如需其他端口，用 `WORKBENCH_ALLOWED_ORIGINS` 设定逗号分隔的完整来源列表。代理仅监听本机地址，拒绝外部网页来源和非本机 Host。不要将这个开发代理暴露到公网。

## 请求协议

```js
const response = await fetch('/api/generate', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    baseUrl: 'https://你的图片服务/v1',
    apiKey: '用户在界面输入的密钥',
    model: '你的图片模型名称',
    prompt: '红色丝绸材质，保持模型的轮廓和姿态',
    size: '4096x4096',
    mode: 'generations',
  }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
const imageDataUrl = result.image;
```

- `baseUrl`：服务商提供的 API 根地址，通常以 `/v1` 结束。也可填写完整 `/images/generations` 或 `/images/edits` 地址。
- `apiKey`：通过 Authorization Bearer 请求头传给指定服务商；不写入日志或项目文件。
- `model`、`prompt`：必填。`size` 默认 `4096x4096`，会原样传给服务商。
- `mode: 'generations'`：JSON 调用 `/images/generations`。不支持携带图片；有参考图应改用 `edits`。
- `mode: 'edits'`：multipart 调用 `/images/edits`。`image` 是当前视口或待修改图片的 data URL；可选 `reference` 是另一张参考图；可选 `mask` 必须为 PNG。
- 只有一张图片时使用 `image` 字段；有视口图和参考图时使用两个 `image[]` 字段。服务商若不支持多参考图，可只发送 `image`。
- `quality`、`background`、`output_format`、`response_format` 是可选字符串。代理不会自动添加可能不被第三方兼容的附加参数。
- 图片 data URL 支持 PNG、JPEG 和 WebP。单张最大 64 MB，完整请求最大 96 MB，生成超时为 240 秒（Lumina 网关自身约 180 秒）。浏览器取消请求时，代理会同时中断发往服务商的请求。

成功响应：

```json
{
  "image": "data:image/png;base64,...",
  "requestedSize": "4096x4096",
  "mode": "generations",
  "revisedPrompt": "服务商可能返回的重写描述"
}
```

失败响应：`{ "error": "中文错误说明" }`，HTTP 状态为 4xx/5xx。收到响应后，前端应读取图片实际宽高并显示；`requestedSize` 仅表示请求尺寸，不代表服务商确实返回 4K。代理不会在 4K 失败后默默改成低分辨率，也不会自动重试付费生成。

生成服务的 4K 支持取决于你所选的模型和供应商。模型不接受 `4096x4096` 时，界面需要让用户自行选择该服务允许的尺寸；最终 UV 贴图画布仍可保持 4096×4096，但放大不是新增真实细节。

## 验证

```sh
node --test tests/api-server.test.mjs
```

测试使用本地模拟响应，不消耗 API 额度。覆盖生成请求、multipart 编辑、4K 参数透传、返回 URL 下载时不外传 API 密钥、来源限制、错误脱敏、重定向拒绝和超时。
