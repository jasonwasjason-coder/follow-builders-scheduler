#!/usr/bin/env node
/**
 * deliver-wechat.js
 * 读取 follow-builders prepare-digest.js 的输出，
 * 调用 Google Gemini API（完全免费）生成中文摘要，
 * 推送到企业微信群机器人。
 */

const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WECHAT_WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL;

// ── 读取标准输入 ──────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

// ── 调用 Google Gemini API 生成中文摘要（免费）────────────────
function callGemini(rawContent) {
  if (!GEMINI_API_KEY) throw new Error('缺少环境变量 GEMINI_API_KEY');

  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  const prompt = `今天是${today}。以下是从 follow-builders skill 抓取的 AI 构建者们的最新动态。

请将内容整理成**企业微信 Markdown 格式**的中文日报，严格遵守以下规则：
1. 第一行标题：**🤖 AI Builder 日报 | ${today}**
2. 选取最有价值的 5～8 条资讯，每条格式：
   **[序号]. [资讯主题]**
   一到两句中文摘要，简洁精准。
   > [查看原文](原文链接)  ← 如果原文有 URL 则保留，没有则省略此行
3. 末尾固定加一行：
   ---
   *由 Gemini + follow-builders skill 自动生成*
4. 总字节数控制在 3800 字节以内（企业微信 Markdown 上限 4096 字节）。
5. 不要加任何额外解释，直接输出 Markdown 正文。

---
原始内容：
${rawContent.substring(0, 12000)}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 1500,
        temperature: 0.3,
      },
    });

    const path =
      `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            resolve(text);
          } else {
            reject(new Error('Gemini API 返回异常：' + data));
          }
        } catch (e) {
          reject(new Error('解析 Gemini 响应失败：' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 推送到企业微信 ────────────────────────────────────────────
function sendToWechat(markdownContent) {
  if (!WECHAT_WEBHOOK_URL) throw new Error('缺少环境变量 WECHAT_WEBHOOK_URL');

  return new Promise((resolve, reject) => {
    const url = new URL(WECHAT_WEBHOOK_URL);
    const body = JSON.stringify({
      msgtype: 'markdown',
      markdown: { content: markdownContent },
    });

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          if (resp.errcode === 0) {
            resolve();
          } else {
            reject(new Error('企业微信 API 错误：' + JSON.stringify(resp)));
          }
        } catch (e) {
          reject(new Error('解析企业微信响应失败：' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  try {
    console.log('📥 读取 prepare-digest.js 输出...');
    const rawContent = await readStdin();

    if (!rawContent.trim()) {
      console.error('❌ 未收到任何内容，请检查 prepare-digest.js 是否正常运行。');
      process.exit(1);
    }

    console.log(`📄 收到 ${rawContent.length} 个字符的原始内容`);
    console.log('🤖 调用 Google Gemini API 生成中文摘要...');

    const summary = await callGemini(rawContent);

    console.log('📨 推送到企业微信...');
    await sendToWechat(summary);

    console.log('✅ 企业微信日报推送成功！');
  } catch (err) {
    console.error('❌ 出错：', err.message);
    process.exit(1);
  }
}

main();
