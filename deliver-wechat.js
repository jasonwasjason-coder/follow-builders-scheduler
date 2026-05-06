#!/usr/bin/env node
// VERSION: v4 - Chinese translation, today-first filter, follow-builders only

const https = require('https');
const WECHAT_WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL;

// ── 读取标准输入 ──────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) { resolve(''); return; }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

// ── 清理播客文字稿时间戳，取前几句 ────────────────────────────
function cleanTranscript(text, maxLen) {
  if (!text) return '';
  return text
    .replace(/Speaker \d+ \| [\d:]+ - [\d:]+\n?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen);
}

// ── 用 MyMemory 免费 API 翻译为中文（无需注册/API Key）────────
function translate(text) {
  if (!text || !text.trim()) return Promise.resolve('');
  const clean = text.trim().substring(0, 400);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.mymemory.translated.net',
      path: `/get?q=${encodeURIComponent(clean)}&langpair=en|zh-CN`,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          const t = resp?.responseData?.translatedText;
          resolve((t && resp.responseStatus === 200) ? t : clean);
        } catch { resolve(clean); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(clean); });
    req.on('error', () => resolve(clean));
    req.end();
  });
}

// ── 判断某条资讯是否在 N 天以内 ──────────────────────────────
function isWithinDays(dateStr, days) {
  if (!dateStr) return false;
  const diffMs = Date.now() - new Date(dateStr).getTime();
  return diffMs >= 0 && diffMs <= days * 86400000;
}

// ── 从 follow-builders JSON 提取所有资讯条目 ─────────────────
function extractItems(data) {
  const items = [];

  // 播客 / YouTube
  (data.podcasts || []).forEach(p => items.push({
    icon: '🎙️',
    title: p.title || p.name || '',
    summary: cleanTranscript(p.transcript, 250),
    url: p.url || '',
    date: p.publishedAt || '',
  }));

  // X / Twitter 帖子
  (data.posts || data.tweets || []).forEach(p => items.push({
    icon: '𝕏',
    title: `@${p.author || p.username || p.name || 'Builder'}`,
    summary: String(p.content || p.text || '').substring(0, 250),
    url: p.url || p.link || '',
    date: p.publishedAt || p.createdAt || '',
  }));

  // 博客文章
  (data.articles || data.blogs || []).forEach(a => items.push({
    icon: '📄',
    title: a.title || '',
    summary: String(a.summary || a.description || '').substring(0, 250),
    url: a.url || a.link || '',
    date: a.publishedAt || a.date || '',
  }));

  return items;
}

// ── 构建完整消息 ──────────────────────────────────────────────
async function buildMessage(rawContent) {
  const today = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const header = `**🤖 AI Builder 日报 | ${today}**\n\n`;

  let selected = [];
  let dateNote = '';

  try {
    const data = JSON.parse(rawContent);
    const all = extractItems(data);

    // 优先今日资讯 → 近 7 天 → 全部兜底（均来自 follow-builders）
    selected = all.filter(x => isWithinDays(x.date, 1));
    if (!selected.length) {
      selected = all.filter(x => isWithinDays(x.date, 7));
      if (selected.length) dateNote = '*(今日暂无新资讯，以下为近期内容)*\n\n';
    }
    if (!selected.length) {
      selected = all;
      if (selected.length) dateNote = '*(近期暂无新资讯，以下为最新可用内容)*\n\n';
    }
    selected = selected.slice(0, 8);
  } catch {
    return header + rawContent.substring(0, 3500);
  }

  if (!selected.length) {
    return header + '今日暂无新资讯，请明日再查看。';
  }

  // 并行翻译所有条目的标题和摘要
  console.log(`🌐 翻译 ${selected.length} 条资讯...`);
  const translated = await Promise.all(
    selected.map(async item => {
      const [titleZh, summaryZh] = await Promise.all([
        translate(item.title),
        translate(item.summary),
      ]);
      return { ...item, titleZh, summaryZh };
    })
  );

  // 拼装消息正文
  let body = dateNote;
  translated.forEach((item, i) => {
    const t = (item.titleZh || item.title).substring(0, 60);
    const s = (item.summaryZh || item.summary).substring(0, 150);
    body += `**${i + 1}. ${item.icon} ${t}**\n`;
    if (s) body += `${s}\n`;
    if (item.url) body += `> [查看原文](${item.url})\n`;
    body += '\n';
  });

  // 控制总字节数 ≤ 3900（企业微信 Markdown 上限 4096 字节）
  let message = header + body;
  if (Buffer.byteLength(message, 'utf8') > 3900) {
    const maxBody = 3900 - Buffer.byteLength(header, 'utf8');
    let truncated = '';
    for (const c of body) {
      if (Buffer.byteLength(truncated + c, 'utf8') > maxBody) break;
      truncated += c;
    }
    message = header + truncated;
  }

  return message;
}

// ── 推送到企业微信 ────────────────────────────────────────────
function sendToWechat(content) {
  if (!WECHAT_WEBHOOK_URL) throw new Error('缺少环境变量 WECHAT_WEBHOOK_URL');
  return new Promise((resolve, reject) => {
    const url = new URL(WECHAT_WEBHOOK_URL);
    const body = JSON.stringify({ msgtype: 'markdown', markdown: { content } });
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          resp.errcode === 0 ? resolve() : reject(new Error('企业微信错误：' + JSON.stringify(resp)));
        } catch (e) { reject(e); }
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
    const raw = await readStdin();
    if (!raw.trim()) { console.error('❌ 未收到任何内容'); process.exit(1); }

    console.log(`📄 收到 ${raw.length} 个字符`);
    const message = await buildMessage(raw);

    console.log('📨 推送到企业微信...');
    await sendToWechat(message);
    console.log('✅ 推送成功！');
  } catch (e) {
    console.error('❌ 出错：', e.message);
    process.exit(1);
  }
}

main();
