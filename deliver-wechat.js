#!/usr/bin/env node
// VERSION: Direct format v2 (handles follow-builders JSON structure)

const https = require('https');

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

// 清理播客文字稿里的时间戳标记，取前几句作为摘要
function cleanTranscript(transcript, maxLen) {
  if (!transcript) return '';
  return transcript
    .replace(/Speaker \d+ \| [\d:]+ - [\d:]+\n?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);
}

function formatForWechat(rawContent) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });

  const header = `**🤖 AI Builder 日报 | ${today}**\n\n`;
  const footer = `\n---\n*由 follow-builders skill 自动生成*`;
  let body = '';
  let itemCount = 0;

  try {
    const data = JSON.parse(rawContent);
    const allItems = [];

    // 播客 / YouTube
    (data.podcasts || []).forEach(p => {
      allItems.push({
        icon: '🎙️',
        title: p.title || p.name || 'Podcast',
        summary: cleanTranscript(p.transcript, 120),
        url: p.url || '',
      });
    });

    // X / Twitter 帖子
    (data.posts || data.tweets || []).forEach(p => {
      allItems.push({
        icon: '𝕏',
        title: `@${p.author || p.username || p.name || 'Builder'}`,
        summary: String(p.content || p.text || p.body || '').substring(0, 120),
        url: p.url || p.link || '',
      });
    });

    // 博客文章
    (data.articles || data.blogs || []).forEach(a => {
      allItems.push({
        icon: '📄',
        title: a.title || 'Article',
        summary: String(a.summary || a.description || a.content || '').substring(0, 120),
        url: a.url || a.link || '',
      });
    });

    const selected = allItems.slice(0, 8);
    selected.forEach((item, i) => {
      body += `**${i + 1}. ${item.icon} ${item.title.substring(0, 55)}**\n`;
      if (item.summary) body += `${item.summary}…\n`;
      if (item.url)     body += `> [查看原文](${item.url})\n`;
      body += '\n';
    });
    itemCount = selected.length;

  } catch {
    // 非 JSON，按段落截取
    const paras = rawContent.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 20).slice(0, 8);
    paras.forEach((p, i) => {
      body += `**${i + 1}.** ${p.substring(0, 150)}\n\n`;
    });
    itemCount = paras.length;
  }

  if (itemCount === 0) {
    body = rawContent.substring(0, 3000);
  }

  // 控制总字节数 ≤ 3900（企业微信 Markdown 上限 4096 字节）
  let message = header + body + footer;
  if (Buffer.byteLength(message, 'utf8') > 3900) {
    const maxBody = 3900 - Buffer.byteLength(header + footer, 'utf8');
    let truncated = '';
    for (const char of body) {
      if (Buffer.byteLength(truncated + char, 'utf8') > maxBody) break;
      truncated += char;
    }
    message = header + truncated + footer;
  }

  return message;
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
          reject(new Error('解析响应失败：' + e.message));
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
