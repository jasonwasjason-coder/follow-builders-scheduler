#!/usr/bin/env node
// VERSION: GitHub Models (no external API key needed)

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WECHAT_WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function callGitHubModels(rawContent) {
  if (!GITHUB_TOKEN) throw new Error('缺少环境变量 GITHUB_TOKEN');

  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const prompt = `今天是${today}。以下是从 follow-builders skill 抓取的 AI 构建者们的最新动态。

请将内容整理成企业微信 Markdown 格式的中文日报，严格遵守以下规则：
1. 第一行标题：**🤖 AI Builder 日报 | ${today}**
2. 选取最有价值的 5～8 条资讯，每条格式：
   **[序号]. [资讯主题]**
   一到两句中文摘要，简洁精准。
   > [查看原文](原文链接)
3. 末尾固定加：
   ---
   *由 GitHub Models + follow-builders skill 自动生成*
4. 总长度控制在 3800 字节以内。
5. 直接输出正文，不要加任何额外说明。

原始内容：
${rawContent.substring(0, 8000)}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.3,
    });

    const options = {
      hostname: 'models.inference.ai.azure.com',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          const text = resp?.choices?.[0]?.message?.content;
          if (text) {
            resolve(text);
          } else {
            reject(new Error('GitHub Models 返回异常：' + data));
          }
        } catch (e) {
          reject(new Error('解析响应失败：' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
            reject(new Error('企业微信错误：' + JSON.stringify(resp)));
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

async function main() {
  try {
    console.log('📥 读取 prepare-digest.js 输出...');
    const rawContent = await readStdin();

    if (!rawContent.trim()) {
      console.error('❌ 未收到任何内容');
      process.exit(1);
    }

    console.log(`📄 收到 ${rawContent.length} 个字符`);
    console.log('🤖 调用 GitHub Models API 生成中文摘要...');

    const summary = await callGitHubModels(rawContent);

    console.log('📨 推送到企业微信...');
    await sendToWechat(summary);

    console.log('✅ 推送成功！');
  } catch (err) {
    console.error('❌ 出错：', err.message);
    process.exit(1);
  }
}

main();
