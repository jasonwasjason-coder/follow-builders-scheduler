#!/usr/bin/env node
// VERSION: Direct format (no AI API needed)

const https = require('https');

const WECHAT_WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL;

// ── 读取标准输入 ──────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

// ── 将原始内容格式化为企业微信 Markdown ──────────────────────
function formatForWechat(rawContent) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  let body = '';

  // 尝试解析为 JSON
  try {
    const data = JSON.parse(rawContent);
    const items = Array.isArray(data) ? data : (data.items || data.posts || data.articles || []);

    if (items.length > 0) {
      const selected = items.slice(0, 8);
      selected.forEach((item, i) => {
        const title = item.title || item.subject || item.name || `资讯 ${i + 1}`;
        const summary = item.summary || item.description || item.content || item.text || '';
        const url = item.url || item.link || item.href || '';

        body += `**${i + 1}. ${String(title).substring(0, 60)}**\n`;
        if (summary) {
          body += `${String(summary).substring(0, 120)}\n`;
        }
        if (url) {
          body += `> [查看原文](${url})\n`;
        }
        body += '\n';
      });
    } else {
      // JSON 但没有数组，直接截取文本
      body = String(rawContent).substring(0, 3000);
    }
  } catch {
    // 纯文本：按段落分割，取前若干段
    const paragraphs = rawContent
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(p => p.length > 20)
      .slice(0, 10);

    paragraphs.forEach((p, i) => {
      body += `**${i + 1}.** ${p.substring(0, 150)}\n\n`;
    });
  }

  // 控制总长度（企业微信 Markdown 上限 4096 字节）
  const header = `**🤖 AI Builder 日报 | ${today}**\n\n`;
  const footer = `\n---\n*由 follow-builders skill 自动生成*`;

  let message = header + body + footer;
  if (Buffer.byteLength(message, 'utf8') > 3900) {
    // 超长则截断 body
    const maxBody = 3900 - Buffer.byteLength(header + footer, 'utf8');
    let truncated = '';
    for (const char of body) {
      if (Buffer.byteLength(truncated + char, 'utf8') > maxBody) break;
      truncated += char;
    }
    message = header + truncated + '\n' + footer;
  }

  return message;
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

// ── 主流程 ────────────────────────────────────────────────────
async function main() {
  try {
    console.log('📥 读取 prepare-digest.js 输出...');
    const rawContent = await readStdin();

    if (!rawContent.trim()) {
      console.error('❌ 未收到任何内容');
      process.exit(1);
    }

    console.log(`📄 收到 ${rawContent.length} 个字符`);
    console.log('📝 格式化内容...');

    const message = formatForWechat(rawContent);

    console.log('📨 推送到企业微信...');
    await sendToWechat(message);

    console.log('✅ 推送成功！');
  } catch (err) {
    console.error('❌ 出错：', err.message);
    process.exit(1);
  }
}

main();
