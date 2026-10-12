# DeepSeek 额度台账

批量查询 DeepSeek API Key 余额的纯静态网页。**密钥不出浏览器**：全部逻辑在前端运行，查询只发往 DeepSeek 官方接口，密钥与查询结果仅保存在当前浏览器的 localStorage 中。

在线使用：把仓库部署到 GitHub Pages 后访问即可（见下文），也可以下载后直接双击 `index.html` 离线打开。

## 功能

- **批量查询**：一次粘贴多个密钥（换行 / 空格 / 逗号分隔，自动去重、自动跳过无法识别的内容），可调并发数（1–8），支持中途停止。
- **展示全部可查字段**：可用状态（`is_available`）、币种、总余额、充值余额（`tossed_balance`）、赠送余额（`granted_balance`），以及余额构成条（充值 / 赠送占比）。
- **密钥管理**：备注命名、显示 / 隐藏 / 复制密钥、按状态筛选、搜索、排序、汇总统计（各币种合计）、勾选批量删除、一键清空。
- **备份恢复**：导出 JSON（完整备份）/ CSV（表格查看）；导入 JSON 备份或纯文本密钥列表，自动按密钥去重合并。
- **双主题**：跟随系统 / 浅色 / 深色；移动端自适应为卡片布局。

## 安全模型

| 问题 | 答案 |
| --- | --- |
| 密钥会发给谁？ | 只发给 DeepSeek 官方：`GET https://api.deepseek.com/user/balance`（请求头 `Authorization: Bearer <密钥>`） |
| 有后端服务器吗？ | 没有。纯静态页面，没有服务器参与 |
| 密钥存在哪？ | 仅当前浏览器的 localStorage，清除站点数据即彻底删除 |
| 有统计 / 第三方资源吗？ | 没有。不加载任何外部脚本、字体、图标或统计工具 |
| 如何强制保证？ | 页面内置内容安全策略（CSP）：`connect-src https://api.deepseek.com`，浏览器会直接拦截向其它地址的请求 |

> 公用电脑使用后建议点击「清空」；导出的 JSON / CSV 备份包含完整密钥，请像保管密码一样保管。

## 部署到 GitHub Pages

### 方式一：GitHub Actions 自动部署（推荐）

1. 把本仓库推送到 GitHub（分支名 `main`）。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 之后每次 push 会自动部署，地址为 `https://<用户名>.github.io/<仓库名>/`。

工作流见 [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)，也可以在 Actions 页面手动触发（workflow_dispatch）。

### 方式二：从分支部署

1. 推送仓库到 GitHub。
2. **Settings → Pages → Source** 选择 **Deploy from a branch**，选 `main` 分支根目录（`/ (root)`）。

## 本地运行

```bash
# 任选一种静态服务器
python3 -m http.server 8137
npx serve .
```

访问 <http://127.0.0.1:8137/>。也可以直接双击 `index.html` 用 `file://` 打开——查询功能同样可用（CORS 对 `file:` 空源同样放行），但建议使用本地服务器。

> 需要浏览器能访问 `api.deepseek.com`；若使用代理，请在浏览器代理设置中放行该域名。

## 目录结构

```
.
├── index.html                      # 页面结构 + 内联 SVG 图标
├── assets/
│   ├── style.css                   # 主题 / 布局 / 响应式
│   └── app.js                      # 查询、状态、localStorage、导入导出
├── .nojekyll                       # 跳过 Jekyll 处理
└── .github/workflows/deploy-pages.yml
```

## 接口说明

查询使用 DeepSeek 官方「查询余额」接口：

- 请求：`GET https://api.deepseek.com/user/balance`，鉴权 `Authorization: Bearer <your-key>`
- 成功（200）：

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",
      "tossed_balance": "100.00"
    }
  ]
}
```

- 密钥无效返回 401；触发限流返回 429（页面会提示降低并发）。

## 免责声明

本项目为开源社区工具，与 DeepSeek 官方无关；额度数据以 DeepSeek 官方平台为准。请遵守 DeepSeek 服务条款，勿查询不属于你的密钥。

## License

[MIT](LICENSE)
